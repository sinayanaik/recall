// The number on a highlight that has something written about it.
//
// format/highlight-notes.js is the storage side: the text lives as plain
// markdown in a "## Highlight Notes" section at the end of the same note, and
// the <mark> in the body carries only a short id pointing at it. That is a good
// place to KEEP a note and a bad place to READ one — the annotation for a
// sentence on page 3 sits four hundred paragraphs below the sentence, and until
// you tap the highlight there is nothing on screen to say the note exists at
// all.
//
// So an annotated highlight wears a numbered badge, and pressing it opens that
// note. Two facts in one glyph: there is something here, and it is the third
// thing you wrote. A highlight with NO note wears nothing — the number is the
// whole indicator, and a mark with nothing behind it must not offer one.
//
// ── What used to be here ──────────────────────────────────────────────────
//
// A second, opt-in mode PRINTED every note into the paragraph it belonged to:
// merged into the sentence in a tinted box when it was one line, as a block
// under it when it was more. It is gone. Reading a note is a press on its
// number now, or the Highlights tab, which is a continuous editor of every note
// in the deck rather than a list to scroll. What that mode cost while it
// existed is the reason this file still opens with a rule about pixels:
// injecting real content into rendered markdown needed two selection skips, a
// user-select guard, a placement pass that had to reason about how the
// incremental renderer compares a chunk's children, and an aria-hidden second
// copy of every note for anything reading the page aloud.
//
// ── Nothing here may advance the text by a pixel ──────────────────────────
//
// styles/23-highlight-marks.css exists entirely because a mark that widens its
// own text re-wraps the block it is in, and a rewrap after renderNotesViewPinned
// has measured its anchor is the "severe shivering when I highlight" report.
//
// The badge is therefore `position: absolute` inside the mark — which is already
// `position: relative` when annotated, for exactly this. An out-of-flow box
// contributes nothing to the line box, so it can carry a background, a ring and
// two digits of padding and still move no glyph. That is what lets it be a real
// element rather than a ::after: a pseudo-element cannot be pressed on its own
// (a click on one is a click on the mark, which opens the mark menu) and cannot
// be reached by keyboard at all.
//
// ── ...and why the source matcher must never see it ───────────────────────
//
// locateSelectionInSource finds a rendered selection in the raw markdown by
// matching its text. A digit injected into a <p> would make every highlight,
// cloze and erase on that paragraph miss. Two places already know how to skip an
// element: cleanedSelectionFragment's removal list (which strips `button`
// wholesale, so the badge is already covered there) and the walk in
// emitTextWithLineBreaks, which runs over the LIVE dom and needs the class
// named. The CSS adds user-select: none on top.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hash32 } from "../core/text.js?v=__BUILD__";
import { HIGHLIGHT_SCAN_RE } from "../format/highlight.js?v=__BUILD__";
import { decodeHighlightNote, isHighlightNoteId, readHighlightNotes } from "../format/highlight-notes.js?v=__BUILD__";
import { scopedQueryAll } from "../render/deferred-work.js?v=__BUILD__";

// The class the badge carries. Named once because three other files have to
// agree on it: the selection skip, the stylesheet, and the sweep here. MARK_,
// not NOTE_: src/documents/pdf-page-notes.js already owns NOTE_BADGE_CLASS for
// the same idea pinned to a quad on a page, and two modules cannot declare one
// name (tools/module-symbols.mjs).
export const MARK_BADGE_CLASS = "hl-note-badge";

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
// is numbered alongside the rest instead of being a second case every caller
// has to remember.
//
// Memoized on the source STRING IDENTITY — every path that edits a note assigns
// a fresh string to state.notes, and every path that does not leaves the very
// same object, so this is an O(1) pointer compare in the common case.
let indexSource = null;
let indexValue = null;

// Cheap, stable and small enough to keep: the ids, their numbers and a hash of
// each body. What a full refresh actually needs to know is "did any number or
// any note text change", and this answers it without holding a second copy of
// every note. See refreshHighlightBadges.
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
      // mark-menu.js follows before it lights its pencil up. This is also what
      // makes "a number only where there is something to read" true rather than
      // aspirational — an empty entry never reaches the map.
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

// ── The badge ─────────────────────────────────────────────────────────────

// What pressing one does, registered rather than imported.
//
// The obvious call is openHighlightNoteEditor(sourceMarkIndexFor(mark), …), and
// this file cannot make it: notes/anchors.js imports the render pipeline, which
// imports this module, and notes/highlight-note-editor.js reaches notes-view.js,
// which does too. Both would be cycles through a module that runs on every
// render. So main.js — which already knows both ends — hands the verb over,
// the same registration idiom setDocumentNotesRenderer and
// setHighlightsChangedHandler use.
let openNoteForMark = () => {};

export function setHighlightBadgeHandler(fn) {
  openNoteForMark = typeof fn === "function" ? fn : () => {};
}

function badgeNode(info) {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = MARK_BADGE_CLASS;
  badge.dataset.hnKey = `${info.n}`;
  badge.dataset.hnSig = hash32(info.text);
  badge.textContent = `${info.n}`;
  // The first words of the note, for a pointer. A badge that says only "3" is a
  // footnote marker; one that says what is under it is worth hovering.
  const flat = info.text.replace(/\s+/g, " ").trim();
  badge.title = flat.length > MARK_BADGE_TITLE_CHARS ? `${flat.slice(0, MARK_BADGE_TITLE_CHARS)}…` : flat;
  badge.setAttribute("aria-label", `Note ${info.n} on this highlight`);
  badge.addEventListener("click", (event) => {
    // The notes view's own click handler opens the MARK menu for whatever
    // highlight was pressed. mark-menu.js already declines a press on a
    // <button> inside a mark, so this is belt to those braces — and it is what
    // stops the menu opening behind the note editor if that guard ever moves.
    event.preventDefault();
    event.stopPropagation();
    const mark = badge.closest("mark");
    if (mark) openNoteForMark(mark, badge.getBoundingClientRect(), info.text);
  });
  return badge;
}

// Long enough to be a sentence, short enough that a tooltip is not a paragraph.
// The same figure src/documents/pdf-page-notes.js uses for its own badge, and
// deliberately its own constant rather than an import: notes/ reaching into
// documents/ for a number would be a dependency bought for nothing.
export const MARK_BADGE_TITLE_CHARS = 160;

// ── The passes ────────────────────────────────────────────────────────────

// One mark. `has-note` is the always-on dotted underline; the badge is the
// number on top of it. Both come from the same lookup, so they cannot disagree
// about whether this highlight has anything to say.
function annotateMark(mark, index) {
  const info = index.byAttr.get(mark.getAttribute("data-note"));
  mark.classList.toggle("has-note", Boolean(info));
  const existing = mark.querySelector(`:scope > .${MARK_BADGE_CLASS}`);
  if (!info) {
    existing?.remove();
    return null;
  }
  // Idempotent. The enhancement passes run again on re-render, and a block that
  // patchRenderedBlocks reused still carries the badge it was given last time —
  // so this replaces one whose number or note text has moved and leaves the
  // rest exactly where they are.
  if (existing) {
    if (existing.dataset.hnKey === `${info.n}` && existing.dataset.hnSig === hash32(info.text)) return existing;
    const fresh = badgeNode(info);
    existing.replaceWith(fresh);
    return fresh;
  }
  const badge = badgeNode(info);
  mark.appendChild(badge);
  return badge;
}

// Per-chunk. Called from enhanceRenderedMarkdown with the nodes the incremental
// renderer just built, which is what keeps a book paying only for the part of
// itself that is on screen.
export function annotateHighlightBadges(container, roots = null) {
  if (!container) return;
  const index = highlightNoteIndex(state.notes || "");
  if (!index.byAttr.size) return;
  scopedQueryAll(roots || [container], "mark[data-note]")
    .forEach((mark) => annotateMark(mark, index));
}

// Whole-document. Every path that can change a NUMBER or a note's TEXT comes
// through renderNotesView, so that is the single hook — but it is also the path
// a plain repaint takes, and sweeping a book-sized document for
// `mark[data-note]` (an attribute selector, so no index can answer it) on every
// repaint is exactly the kind of cost this codebase keeps having to take back
// out. The signature is what makes it free: it changes only when a note's
// number or body changed, which is the only time there is anything to redo.
let appliedSignature = null;

export function refreshHighlightBadges({ force = false } = {}) {
  const container = el.notesView;
  if (!container) return;
  const index = highlightNoteIndex(state.notes || "");
  if (!force && index.signature === appliedSignature) return;
  appliedSignature = index.signature;

  // Opening a note with no annotations at all, or deleting the last one: sweep
  // whatever a previous note left behind. Scoped to the class, which is rare
  // enough that nothing here is on a hot path.
  if (!index.byAttr.size) {
    container.querySelectorAll(`.${MARK_BADGE_CLASS}`).forEach((node) => node.remove());
    container.querySelectorAll("mark.has-note").forEach((mark) => mark.classList.remove("has-note"));
    return;
  }

  const wanted = new Set();
  container.querySelectorAll("mark[data-note]").forEach((mark) => {
    const node = annotateMark(mark, index);
    if (node) wanted.add(node);
  });
  // A badge whose highlight has gone (its mark removed, or the note deleted)
  // sits in a block nobody rebuilt. Anything not claimed by the pass above is
  // one of those.
  container.querySelectorAll(`.${MARK_BADGE_CLASS}`).forEach((node) => {
    if (!wanted.has(node)) node.remove();
  });
}
