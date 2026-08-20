// Turning a selection in the RENDERED note back into markdown.
//
// The hard part is that a rendered selection has no source: it is matched back
// by text, and partial selections of atomic blocks (tables, list items, code
// fences) have to be repaired into something that still parses. A code
// selection is re-fenced off the <pre>, not the <code>, because the language
// lives on the parent.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { HIGHLIGHT_MIRROR_MAX_CHARS } from "../editor/highlight-mirror.js?v=__BUILD__";
// block-cache.js reaches back here through notes/toc.js -> notes/anchors.js, so
// this closes a cycle that already existed. Safe for the same reason the
// notes-view.js one below is: measureNotesChunkEstimate is a hoisted `function`
// declaration called at runtime, never a `const` read while a module body is
// still evaluating.
import { measureNotesChunkEstimate } from "../render/block-cache.js?v=__BUILD__";
import { renderedSelectionStrings } from "../format/locate-selection.js?v=__BUILD__";
import { htmlToMarkdown } from "../import/html-to-markdown.js?v=__BUILD__";
import { lineIndexAtOffset } from "./caret.js?v=__BUILD__";
// notes-view.js imports hideNotesSelectionButton from here, so this is a cycle.
// Safe because the only binding crossing it in this direction is a hoisted
// `function` declaration called at runtime — never a `const` read while either
// module body is still evaluating, which is the shape that once aborted the
// whole of app.js.
import { clearProgrammaticNotesSelection, isProgrammaticNotesSelection } from "./notes-view.js?v=__BUILD__";
import { codeLanguageOrGeneric, inferCodeLanguage, normalizeCodeLanguage } from "../render/code-language.js?v=__BUILD__";
import { styleMobileMedia } from "../ui/style-tokens.js?v=__BUILD__";

// The three faces that support "select text → make a flashcard". Only one is
// ever active at a time: notes while state.viewMode === "notes", question/
// answer while state.viewMode === "cards".
export const SELECTION_TARGETS = [
  { name: "notes", view: el.notesView, edit: el.notesEdit, isActive: () => state.viewMode === "notes" },
  { name: "question", view: el.questionView, edit: el.questionEdit, isActive: () => state.viewMode === "cards" },
  { name: "answer", view: el.answerView, edit: el.answerEdit, isActive: () => state.viewMode === "cards" },
];

export function isTargetEditing(target) {
  return Boolean(target.edit && !target.edit.hidden);
}

// The active target (if any) currently in raw-edit mode with a live,
// non-collapsed selection in its textarea.
export function activeEditingTarget() {
  return (
    SELECTION_TARGETS.find((t) => {
      if (!t.isActive() || !isTargetEditing(t)) return false;
      const { selectionStart, selectionEnd } = t.edit;
      return selectionStart !== selectionEnd;
    }) || null
  );
}

// The active target (if any) whose RENDERED view contains the live selection.
export function activeRenderedTarget() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  return (
    SELECTION_TARGETS.find(
      (t) =>
        t.isActive() &&
        !isTargetEditing(t) &&
        t.view &&
        !t.view.hidden &&
        t.view.contains(selection.anchorNode) &&
        t.view.contains(selection.focusNode)
    ) || null
  );
}

export let notesSelectionTimer = null;

// The selection the floating pill was last positioned for, captured AT
// position time. On touch platforms the tap that hits a pill button can
// dissolve the live selection before the handler reads it (iOS Safari is
// notorious), so the pill's highlight/erase/cloze actions work from this
// snapshot instead of re-reading window.getSelection() mid-tap. Cleared
// whenever the pill hides, so it can never act on a stale selection.
//   { targetName, editing, sel, markdown }
export let pillSelectionCapture = null;

export function hideNotesSelectionButton() {
  // Called from every scroll event on the notes view and the raw editor, where
  // "already fully hidden" is the overwhelmingly common case — make that a few
  // property reads rather than half a dozen redundant DOM writes. The menu is
  // tested separately on purpose: it is a child of the pill, so hiding the pill
  // hides it visually while leaving its own `hidden` false, and skipping the
  // reset below would spring it back open on the next selection.
  // The formatting disclosure is tested here alongside the colour menu and for
  // the same reason: it is a CLASS on the pill, so hiding the pill hides it
  // visually while leaving the class set, and the next selection would open
  // already expanded — the one state the collapsed-by-default bar exists to
  // avoid. It has to be part of the fast path's "already fully reset" test too,
  // or that early return skips the only place it gets cleared.
  if (el.selectionFloat?.hidden
      && !pillSelectionCapture
      && !el.selectionFloat.classList.contains("is-format-open")
      && el.highlightSelectionMenu?.hidden !== false) {
    return;
  }
  if (el.selectionFloat) {
    el.selectionFloat.hidden = true;
    el.selectionFloat.classList.remove("is-format-open");
    el.selectionFormatToggleBtn?.setAttribute("aria-expanded", "false");
  }
  if (el.makeCardFromSelectionBtn) el.makeCardFromSelectionBtn.dataset.selectionText = "";
  // The colour menu is a child of the pill, so hiding the pill hides it too —
  // but it would come back open on the next selection without this.
  if (el.highlightSelectionMenu) {
    el.highlightSelectionMenu.hidden = true;
    el.highlightSelectionMenuBtn?.setAttribute("aria-expanded", "false");
  }
  pillSelectionCapture = null;
}

// The live selection's range, but only when it's a real selection inside the
// given target's rendered view.
export function notesSelectionRange(target) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  if (!target?.view || target.view.hidden) return null;
  if (!target.view.contains(selection.anchorNode) || !target.view.contains(selection.focusNode)) return null;
  return selection.getRangeAt(0);
}

// Blocks that render into something with no usable text of their own, but whose
// original markdown source is stashed on the host element: formulas (data-tex,
// written by mathNode) and mermaid/nomnoml diagrams (data-diagram, written by
// preprocessSpecialBlocks). Both are all-or-nothing — half a rendered formula
// or half an SVG can't be turned back into source — so a selection boundary
// landing inside one gets pushed out to its edge.
export const ATOMIC_SOURCE_SELECTOR = ".math-inline[data-tex], .math-display[data-tex], [data-diagram]";

// The atomic host a range boundary sits in, or null. Same shape as
// boundaryCodeBlock below and for the same reason: both the container AND the
// child the offset points at have to be considered, because a boundary dropped
// just past a formula parks ON the parent with an offset pointing INTO it,
// which .closest() alone would miss.
export function boundaryAtomicHost(container, offset) {
  const start = container.nodeType === Node.TEXT_NODE
    ? container.parentElement
    : (container.childNodes[Math.min(offset, container.childNodes.length - 1)] || container);
  const node = start?.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  return node?.closest?.(ATOMIC_SOURCE_SELECTOR)
    || (container.nodeType === Node.ELEMENT_NODE ? container.closest?.(ATOMIC_SOURCE_SELECTOR) : null)
    || null;
}

// Widen a range so it never cuts an atomic block in half. KaTeX renders one
// `$x^2$` into a tree of glyph spans plus a hidden MathML twin, and mermaid
// renders a fence into an <svg> with an inline <style>; a boundary landing
// inside either clones a meaningless slice, which came out of the
// HTML→Markdown path as duplicated glyph soup ("x2x2") or, for a diagram, as
// the SVG's stylesheet as literal text. Snapping outward is both the only
// recoverable answer and the one the user meant. Everything downstream then
// sees complete hosts, which the math-source / keep-diagram-source Turndown
// rules and textWithLineBreaks below all know how to turn back into source.
export function snapRangeToAtomicBlocks(range) {
  const startHost = boundaryAtomicHost(range.startContainer, range.startOffset);
  const endHost = boundaryAtomicHost(range.endContainer, range.endOffset);
  if (!startHost && !endHost) return range;
  // Never mutate the live selection's own range — moving its boundaries under
  // the user would visibly redraw (or drop) their highlight.
  const snapped = range.cloneRange();
  try {
    if (startHost) snapped.setStartBefore(startHost);
    if (endHost) snapped.setEndAfter(endHost);
  } catch (_) {
    return range;
  }
  return snapped;
}

// Range.cloneContents() rebuilds partial ancestors *inside* the range but never
// the common ancestor itself, so selecting across a table hands back bare
// <tr>/<tbody> with no <table> around them — and Turndown's GFM table rule,
// which filters on the table element, doesn't fire. The result was a whole
// table flattened to "Element Symbol Hydrogen H Helium He" on one line. Put the
// wrapper back (with the header row, so a couple of selected rows still make a
// legible standalone table) and the rule fires as it does for every other block.
export const ORPHAN_TABLE_PARTS = "thead, tbody, tfoot, tr, th, td";

export function restoreSelectionTables(container, range) {
  const children = Array.from(container.children);
  const firstOrphan = children.findIndex((node) => node.matches(ORPHAN_TABLE_PARTS));
  if (firstOrphan === -1) return;
  const anchorNode = range.commonAncestorContainer;
  const anchorEl = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
  const sourceTable = anchorEl?.closest?.("table");
  if (!sourceTable) return;

  // Mark the spot before anything moves — the wrappers below reparent these
  // nodes, so a reference to one of them stops being a child of `container`.
  const slot = document.createComment("table");
  container.insertBefore(slot, children[firstOrphan]);

  let parts = children.filter((node) => node.matches(ORPHAN_TABLE_PARTS));
  // Climb back up whatever levels the clone lost: cells → row → body.
  if (parts.some((node) => node.matches("th, td"))) {
    const row = document.createElement("tr");
    parts.forEach((node) => row.appendChild(node));
    parts = [row];
  }
  if (parts.some((node) => node.matches("tr"))) {
    const body = document.createElement("tbody");
    parts.forEach((node) => body.appendChild(node));
    parts = [body];
  }

  const table = document.createElement("table");
  const head = sourceTable.querySelector("thead");
  // A GFM table without a header row isn't a table at all — Turndown emits it
  // as plain text — so borrow the source's header when the selection missed it.
  if (head && !parts.some((node) => node.tagName === "THEAD")) {
    table.appendChild(head.cloneNode(true));
  }
  parts.forEach((node) => table.appendChild(node));
  slot.replaceWith(table);
}

// The same cloneContents() hole as the table case above, one level down: a
// drag that starts or ends mid-list hands back bare <li>s with no <ul>/<ol>
// around them. Turndown's list-item rule then can't see the list at all — it
// emits every orphan with the DEFAULT bullet ("-   "), so an ordered or
// "*"-bulleted selection serialized to markers that appear nowhere in the
// source and highlight/erase missed every time. Put the source list's own
// wrapper back (and, for an ordered list, the item's real number in `start`,
// which is what the list-item rule reads the number from).
export function restoreSelectionListItems(container, range) {
  const orphans = Array.from(container.children).filter((node) => node.tagName === "LI");
  if (!orphans.length) return;
  const anchorNode = range.commonAncestorContainer;
  const anchorEl = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
  const sourceList = anchorEl?.closest?.("ul, ol");
  if (!sourceList) return;

  const list = document.createElement(sourceList.tagName.toLowerCase());
  if (sourceList.tagName === "OL") {
    // Which item the selection starts at, counted in the SOURCE list (the
    // orphans are clones, so indexOf has to run against the live DOM). The
    // range can start on the list itself (offset = child index) or inside an
    // item's text.
    let startLi = null;
    const sc = range.startContainer;
    if (sc === sourceList) {
      startLi = sourceList.children[range.startOffset] || null;
    } else {
      const startEl = sc.nodeType === Node.ELEMENT_NODE ? sc : sc.parentElement;
      startLi = startEl?.closest?.("li") || null;
    }
    const index = startLi && sourceList.contains(startLi)
      ? Array.prototype.indexOf.call(sourceList.children, startLi)
      : -1;
    if (index > 0) {
      const base = Number(sourceList.getAttribute("start")) || 1;
      list.setAttribute("start", String(base + index));
    }
  }

  const slot = document.createComment("list");
  container.insertBefore(slot, orphans[0]);
  orphans.forEach((li) => list.appendChild(li));
  slot.replaceWith(list);
}

// Clone the selected fragment with rendered-markdown UI chrome removed
// (image/diagram Zoom pills, code-block copy buttons, language badges) and the
// SVG stylesheets mermaid inlines into its output, which otherwise read back as
// a wall of CSS text.
export function cleanedSelectionFragment(range) {
  const snapped = snapRangeToAtomicBlocks(range);
  const container = document.createElement("div");
  container.appendChild(snapped.cloneContents());
  container.querySelectorAll("button, .code-lang-badge, style, script").forEach((node) => node.remove());
  restoreSelectionTables(container, snapped);
  restoreSelectionListItems(container, snapped);
  return container;
}

// marked is configured with `breaks: true` (see marked.setOptions), so every
// bare newline in the source — including an ordinary word-wrapped line inside
// one paragraph, not just a blank line between two — renders as a real <br>
// element. Plain `.textContent`/`Range.toString()` silently drop <br> (it's an
// empty element, not a text node), which glues the line before it straight
// onto the line after with nothing between them — "wrapped like\nthis" reads
// back as "wrapped likethis". That text then can't be found anywhere in the
// raw markdown source, so highlighting (or clozing, or erasing) ANY selection
// that crosses a wrapped line — the common case for more than a short sentence
// — silently failed to match. Walking the tree and emitting "\n" for each
// <br> instead keeps the extracted text shaped the way the source actually is.
//
// A selection spanning two block elements (two <p>s from a selection dragged
// across a blank line, two <li>s down a list, …) has the SAME problem one
// level up: cloning them side by side and reading text out gives no separator
// at all between them, but the raw source has one. <li> siblings get a single
// "\n" (a tight list has no blank line between items); every other block tag
// gets "\n\n" (marked always emits a real blank line between paragraphs,
// headings, blockquotes, etc). This is an approximation — nested/loose lists
// and tables aren't reconstructed exactly — but it covers the common case of
// selecting across an ordinary paragraph or list-item boundary, which used to
// fail outright (locateSelectionInSource has no fallback for it — see its
// "spans block boundaries" comment).
export const TIGHT_BLOCK_TAGS = new Set(["LI"]);

export const LOOSE_BLOCK_TAGS = new Set(["P", "DIV", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "HR", "UL", "OL"]);

// A table's own structure, which the two sets above could not express.
//
// Neither TD/TH nor TR was in either set, so a selected table row came back as
// one run-together string — "ElementSymbolHydrogenH" for a source that reads
// "| Element | Symbol |". Nothing downstream can recover from that: the plain-
// text needle can never match the source, and `occurrence` (counted against the
// same string) is meaningless, so a table highlight either missed outright or
// fell through to looseMarkupMatch's first-hit-anywhere fallback and marked a
// different table. Cells are joined the way the source writes them so the needle
// is findable; rows get their own line, same as any other block.
export const CELL_TAGS = new Set(["TD", "TH"]);

// TR plus the section wrappers. THEAD/TBODY/TFOOT are in here too because a
// table's children are those sections, not its rows — without them the header
// row and the first body row were emitted back to back with nothing between.
export const ROW_TAGS = new Set(["TR", "THEAD", "TBODY", "TFOOT"]);

export const CELL_SEPARATOR = " | ";

// The markdown source behind a rendered atomic block, from what
// preprocessSpecialBlocks stashed on the host: `$…$`/`$$…$$` for a formula (see
// mathNode) or the original fence for a diagram. Returns "" for anything else.
export function atomicSourceForNode(node) {
  const encoded = node?.dataset?.tex || node?.dataset?.diagram;
  if (!encoded) return "";
  let decoded = "";
  try {
    decoded = decodeURIComponent(encoded);
  } catch (_) {
    return "";
  }
  decoded = decoded.trim();
  if (!decoded) return "";
  if (node.dataset.tex) {
    return node.classList.contains("math-display") ? `$$\n${decoded}\n$$` : `$${decoded}$`;
  }
  const lang = node.classList.contains("nomnoml-diagram") ? "nomnoml" : "mermaid";
  return `\`\`\`${lang}\n${decoded}\n\`\`\``;
}

// ── Two ways to consume the same walk ──────────────────────────────────────
//
// textWithLineBreaks used to be the only reader of the walk below, and it
// builds the whole string. That is fine for a selection and ruinous for the
// other caller: renderedSelectionStrings counts how many copies of the selected
// text precede it, which meant building the text of EVERYTHING above the
// selection — a deep DOM clone plus a multi-megabyte string, per selection, on
// the main thread. Measured on a 2.6MB note with the reader two thirds of the
// way down: 218ms on a desktop, and that is the work a phone is doing while the
// reader waits for a long press to take.
//
// So the walk emits into a SINK. One sink accumulates the string; the other
// keeps only a short tail and counts matches as they go by, so the same answer
// costs no allocation at all. Both are needed and they must agree exactly —
// `occurrence` is counted against the very string `asText` is taken from.
export function stringSink() {
  let text = "";
  let written = 0;
  return {
    push(value) { text += value; written += value.length; },
    // Monotonic, and deliberately not affected by dropTrailing: the walk uses
    // it only to ask "did that child emit anything at all", which is what the
    // original's per-level `text` variable answered.
    written() { return written; },
    endsWith(value) { return text.endsWith(value); },
    dropTrailing(pattern) { text = text.replace(pattern, ""); },
    value() { return text; }
  };
}

// Keeps a window of the tail rather than the whole string, and counts
// non-overlapping matches of `needle` exactly the way countOccurrences does:
// left to right, each match consuming its own length.
//
// The window has to cover three things at once — a match that straddles two
// pushes, the endsWith() tests the walk makes, and the trailing-whitespace
// rewrites it makes — so it is the needle's length with a floor under it. A
// trailing whitespace run longer than the window is the one case where this
// could differ from the string sink, and it cannot arise from rendered markdown.
export const COUNTING_SINK_MIN_TAIL = 512;

export function countingSink(needle) {
  const size = Math.max(COUNTING_SINK_MIN_TAIL, needle.length * 2);
  let tail = "";
  let searchAt = 0;
  let count = 0;
  let written = 0;
  const scan = () => {
    if (!needle) return;
    for (;;) {
      const at = tail.indexOf(needle, searchAt);
      if (at === -1) break;
      count += 1;
      searchAt = at + needle.length;
    }
    // Everything before the last (needle.length - 1) characters has been seen
    // in full, so no future match can start there. Keeping `size` of it anyway
    // is what leaves room for the walk's own tail rewrites.
    const drop = Math.max(0, tail.length - size);
    if (!drop) return;
    tail = tail.slice(drop);
    searchAt = Math.max(0, searchAt - drop);
  };
  return {
    push(value) { tail += value; written += value.length; scan(); },
    written() { return written; },
    endsWith(value) { return tail.endsWith(value); },
    dropTrailing(pattern) {
      // Un-emitting characters means un-searching them: anything the scan had
      // already consumed past the new end no longer exists.
      //
      // A match already counted can never be undone by this, and that is what
      // keeps the two sinks in agreement rather than merely close: both
      // patterns here only ever remove a run of TRAILING whitespace, and the
      // needle is `asText`, which is trimmed — so no match can end inside the
      // run being removed.
      tail = tail.replace(pattern, "");
      searchAt = Math.min(searchAt, tail.length);
    },
    count() { return count; }
  };
}

export function textWithLineBreaks(node) {
  const sink = stringSink();
  emitTextWithLineBreaks(node, sink, null);
  return sink.value();
}

// Walks `node`'s children in document order, emitting the text a reader sees.
//
// `stop`, when given, is a { node, offset } boundary: the walk emits everything
// before it and then returns true, which every caller up the stack uses to stop
// walking. That is what lets the occurrence count cover "the note above the
// selection" without materialising a Range or a clone of it.
export function emitTextWithLineBreaks(node, sink, stop) {
  let emittedHere = false;
  let prevBlockTag = null;
  let reached = false;
  // A node the boundary sits inside must be descended into, not summarised.
  const holdsStop = (child) => Boolean(stop) && (child === stop.node || (child.nodeType === 1 && child.contains(stop.node)));
  const children = Array.from(node.childNodes);
  // The boundary can also be expressed as "before the Nth child of this node".
  const limit = stop && node === stop.node ? Math.min(stop.offset, children.length) : children.length;
  if (stop && node === stop.node) reached = true;
  for (let i = 0; i < limit; i += 1) {
    const child = children[i];
    if (child.nodeType === Node.TEXT_NODE) {
      if (stop && child === stop.node) {
        const part = child.data.slice(0, stop.offset);
        if (part) { sink.push(part); emittedHere = true; }
        return true;
      }
      if (child.data) { sink.push(child.data); emittedHere = true; }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (child.tagName === "BR") {
      sink.push("\n");
      emittedHere = true;
      continue;
    }
    // KaTeX emits every formula TWICE: a hidden MathML tree for screen readers
    // and the visible glyph spans. Descending into both doubles every symbol.
    // Skipped even where there's no data-tex host to short-circuit on, so math
    // from the \[…\] auto-render safety net comes back single, not doubled.
    if (child.classList?.contains("katex-mathml")) continue;
    // Mermaid inlines a stylesheet into its SVG; reading it as text emits the
    // whole thing as a wall of CSS.
    if (child.tagName === "STYLE" || child.tagName === "SCRIPT") continue;
    const isTight = TIGHT_BLOCK_TAGS.has(child.tagName);
    const isLoose = LOOSE_BLOCK_TAGS.has(child.tagName);
    const isCell = CELL_TAGS.has(child.tagName);
    const isRow = ROW_TAGS.has(child.tagName);
    // A cell is separated from the previous cell IN THE SAME ROW, never from
    // the row above — hence the prevBlockTag check rather than a bare "has
    // anything been emitted" one, which would put " | " in front of the first
    // cell of every row.
    //
    // `emittedHere`, not "has the sink got anything", because in the original
    // this tested a string local to THIS level of the recursion: the first
    // child of a nested element must not be given a gap just because something
    // further up already wrote text.
    if (isCell && emittedHere && CELL_TAGS.has(prevBlockTag)) sink.push(CELL_SEPARATOR);
    else if (isRow && emittedHere) {
      if (!sink.endsWith("\n")) { sink.dropTrailing(/[ \t]+$/); sink.push("\n"); }
    } else if ((isTight || isLoose) && emittedHere) {
      const gap = isTight && prevBlockTag === "LI" ? "\n" : "\n\n";
      if (!sink.endsWith(gap)) { sink.dropTrailing(/\n+$/); sink.push(gap); }
    }
    // A rendered formula or diagram reads back as its own source, not as its
    // glyphs/SVG — the gap handling above still runs (both are <div>s at block
    // level, loose blocks), but the descent doesn't. This string is what
    // locateSelectionInSource hunts for in the raw markdown, so walking the
    // KaTeX tree instead emitted characters that appear nowhere in the source,
    // which is why highlighting, clozing, erasing and a card's "go to notes"
    // anchor all silently missed on any selection containing math.
    const atomicSource = atomicSourceForNode(child);
    if (isTight || isLoose || isCell || isRow) prevBlockTag = child.tagName;
    if (atomicSource) {
      sink.push(atomicSource);
      emittedHere = emittedHere || Boolean(atomicSource);
      if (holdsStop(child)) return true;
      continue;
    }
    // A cell's own padding is layout, not content: the source writes
    // "| Hydrogen |" and the separator above already supplies the spaces. That
    // trim is the one thing a streaming sink cannot express, so a cell is
    // rendered into a string of its own first — cells are small, and this is
    // exactly what the original did at every level.
    if (isCell) {
      const cellSink = stringSink();
      const hit = emitTextWithLineBreaks(child, cellSink, holdsStop(child) ? stop : null);
      const trimmed = cellSink.value().trim();
      if (trimmed) { sink.push(trimmed); emittedHere = true; }
      if (hit || holdsStop(child)) return true;
      continue;
    }
    // Whether the child emitted ANYTHING is the question, not whether it was
    // visited: an empty <span> left the original's `text` empty, and so must
    // not make the next sibling look like it needs a gap in front of it.
    const before = sink.written();
    const hit = emitTextWithLineBreaks(child, sink, holdsStop(child) ? stop : null);
    if (sink.written() > before) emittedHere = true;
    if (hit || holdsStop(child)) return true;
  }
  return reached;
}

// How many times `needle` appears in the rendered text of `root` BEFORE the
// boundary — the number renderedSelectionStrings hands to
// locateSelectionInSource as `occurrence`, so that highlighting a phrase that
// recurs marks the copy the reader actually selected.
export function countRenderedTextBefore(root, boundaryNode, boundaryOffset, needle) {
  if (!root || !boundaryNode || !needle) return 0;
  // A boundary that is no longer in the view cannot stop the walk, and without
  // this the walk would run to the END of the note and return a count for the
  // whole document — expensive, and wrong in the one direction that matters
  // (too high, so the caller would look for a copy that does not exist).
  // Answering 0 is the documented fallback everywhere else here: a miscounted
  // occurrence degrades to "the first match", never to no match at all.
  if (!root.contains(boundaryNode)) return 0;
  const sink = countingSink(needle);
  emitTextWithLineBreaks(root, sink, { node: boundaryNode, offset: boundaryOffset });
  return sink.count();
}

// The <pre> a range boundary sits in, or null. Both the container and (for an
// element container) the child the offset points at are considered: a triple-
// click or a drag past the last line leaves a boundary ON the <pre>/wrapper
// with an offset pointing INTO it, which .closest() alone would miss.
export function boundaryCodeBlock(container, offset) {
  const start = container.nodeType === Node.TEXT_NODE
    ? container.parentElement
    : (container.childNodes[Math.min(offset, container.childNodes.length - 1)] || container);
  const node = start?.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  return node?.closest?.("pre") || (container.nodeType === Node.ELEMENT_NODE ? container.closest?.("pre") : null) || null;
}

// The language a rendered code block should be fenced with: whatever
// enhanceCodeBlocks settled on (declared ```lang, else its inference), with
// the class/badge as fallbacks for blocks that never went through it.
export function renderedCodeBlockLanguage(pre) {
  const code = pre?.querySelector("code");
  if (!code) return "";
  if (code.dataset.codeLanguage) return code.dataset.codeLanguage;
  const langMatch = code.className.match(/language-([\w+-]*)/);
  if (langMatch && langMatch[1]) return langMatch[1];
  const badge = (pre.dataset.language || "").toLowerCase().replace(/\s+/g, "");
  return badge || codeLanguageOrGeneric(normalizeCodeLanguage(inferCodeLanguage(code.textContent)));
}

// If the selection lands inside a rendered code block, rebuild the fence
// directly from the raw selected text and the block's language instead of
// going through the generic HTML→Markdown conversion — Turndown's fenced-block
// rule only fires when the selection's boundary crosses the whole <pre>; a
// selection that starts/ends *inside* the <code> (the common case — dragging
// across a few lines of a longer block) falls through to its inline-code rule
// instead, which collapses every newline to a space and drops the language.
//
// Matching is done on the <pre>, not the <code>: dragging a hair past the
// first/last line of a block parks that boundary on the <pre> (or the
// scroll wrapper) rather than inside the <code>, and keying off the <code>
// alone dropped exactly those selections back into the unfenced path. The
// language comes from the PARENT block, so a partial selection is fenced the
// same way the whole block is — including when the block's language was
// inferred rather than declared.
export function notesSelectionCodeFence(range, target) {
  const startPre = boundaryCodeBlock(range.startContainer, range.startOffset);
  if (!startPre || !target?.view?.contains(startPre)) return null;
  // Only when the whole selection is one block's code. A selection that runs
  // from a code block into the prose after it (or across two blocks) has real
  // structure to preserve and belongs on the HTML→Markdown path, which keeps
  // the fence anyway because the <pre> is cloned intact.
  const endPre = boundaryCodeBlock(range.endContainer, range.endOffset);
  if (endPre !== startPre) return null;
  const raw = range.toString();
  if (!raw.trim()) return null;
  const lang = renderedCodeBlockLanguage(startPre);
  // The copy button is the <pre>'s last child, so its label rides along at the
  // END of range.toString() once the selection reaches the block's edge. Strip
  // it there only — a bare replace would also eat a legitimate "SQL" sitting
  // in a comment somewhere in the middle of the code.
  const label = startPre.querySelector(".code-copy-btn")?.textContent || "";
  const body = label && raw.endsWith(label) ? raw.slice(0, -label.length) : raw;
  const trimmed = body.replace(/^\n+|\n+$/g, "");
  if (!trimmed.trim()) return null;
  return `\`\`\`${lang}\n${leadingCodeIndent(startPre, range)}${trimmed}\n\`\`\``;
}

// Whitespace between the start of the first selected line and the selection
// itself. A drag almost never lands exactly on column 0, so without this the
// first line of a card arrives dedented while every line under it keeps its
// indentation — which in Python is not just ugly, it's a syntax error. Only
// whitespace is reclaimed: if the selection starts mid-token, nothing is
// added rather than inventing code the user didn't highlight.
export function leadingCodeIndent(pre, range) {
  const code = pre.querySelector("code");
  if (!code) return "";
  const before = document.createRange();
  try {
    before.selectNodeContents(code);
    before.setEnd(range.startContainer, range.startOffset);
  } catch (_) {
    return "";
  }
  const text = before.toString();
  const prefix = text.slice(text.lastIndexOf("\n") + 1);
  return /^[ \t]+$/.test(prefix) ? prefix : "";
}

// Serialize the notes selection back to MARKDOWN, so images, math, bold text
// etc. survive into the card. selection.toString() would only give plain
// text — for a selected image it literally yields the "Zoom" button label of
// its .diagram-shell wrapper.
// `described` is renderedSelectionStrings' answer for the SAME range, when the
// caller already has one. It carries exactly the two strings this needs —
// `asMarkdown` is the same Turndown run over the same cleaned fragment, and
// `asText` is the same textWithLineBreaks walk — so passing it through turns two
// clones of the selection plus two Turndown passes into one of each. That
// duplication was paid on every finished selection, by the pill's capture, which
// asked for both.
export function notesSelectionMarkdown(range, target, described = null) {
  const codeFence = notesSelectionCodeFence(range, target);
  if (codeFence) return codeFence;
  if (described) {
    if (!described.asMarkdown) return described.asText;
    return withInferredFenceLanguages(described.asMarkdown);
  }
  const fragment = cleanedSelectionFragment(range);
  const markdown = htmlToMarkdown(fragment.innerHTML, { preserveInlineStyles: true }).trim();
  if (!markdown) return textWithLineBreaks(fragment).trim();
  // Turndown puts the language on the fence from the <code> class, which
  // enhanceCodeBlocks sets for guessed languages too — this catches whatever
  // reached the markdown as a bare fence anyway.
  return withInferredFenceLanguages(markdown);
}

// A fenced block in raw markdown: optional indent, 3+ backticks, an info
// string, the body, and the closing run. `m` + `^` so a ``` inside a string
// mid-line can't open a phantom fence.
export const RAW_FENCE_RE = /^[ \t]*(`{3,})([^\n`]*)\n([\s\S]*?)(\n[ \t]*\1`*[ \t]*)$/gm;

// If [start, end) in the raw markdown sits inside an existing ```lang fence,
// return its language; else null. Used so selecting just the inner
// lines of a code block (not the ``` marker lines themselves) still keeps its
// fence + language when turned into a card. A fence that declares no language
// contributes the same guess the rendered block shows, so a partial selection
// out of an undeclared block still lands on the card as highlightable code.
// How much of the document either side of the selection is searched for an
// enclosing fence. A code block big enough to fall outside this simply doesn't
// get its language carried onto the card — the same outcome as an undeclared
// fence, which the caller already handles.
//
// The bound matters because RAW_FENCE_RE is a lazy `[\s\S]*?` closed by a
// backreference: when a ``` has no matching close — which is the state the text
// is in the entire time you are part-way through typing a code block — every
// opener in the note rescans to end-of-document before failing. Measured on
// text with one unterminated fence: 320ms at 200KB and 8,185ms at 1MB, on every
// selection change in raw mode.
export const RAW_FENCE_SEARCH_WINDOW = 20000;

export function findRawCodeFence(value, start, end) {
  let from = Math.max(0, start - RAW_FENCE_SEARCH_WINDOW);
  let to = Math.min(value.length, end + RAW_FENCE_SEARCH_WINDOW);
  // Snapped to line boundaries so the pattern's ^ and $ still anchor to real
  // lines rather than to the arbitrary points the window happened to cut.
  if (from > 0) {
    const newline = value.indexOf("\n", from);
    from = newline === -1 || newline >= start ? 0 : newline + 1;
  }
  if (to < value.length) {
    const newline = value.indexOf("\n", to);
    to = newline === -1 ? value.length : newline;
  }
  const slice = from === 0 && to === value.length ? value : value.slice(from, to);

  RAW_FENCE_RE.lastIndex = 0;
  let match;
  while ((match = RAW_FENCE_RE.exec(slice))) {
    const bodyStart = from + match.index + match[0].indexOf("\n") + 1;
    const bodyEnd = bodyStart + match[3].length;
    if (start >= bodyStart && end <= bodyEnd) {
      const declared = match[2].trim();
      return { language: declared || codeLanguageOrGeneric(inferCodeLanguage(match[3])) };
    }
  }
  return null;
}

// Stamp a guessed language onto every bare ``` fence in a chunk of markdown.
// Applied only to text being lifted OUT of a note (into a card, a cloze, a
// quick note) — the note's own source is never rewritten behind the user.
export function withInferredFenceLanguages(markdown) {
  return String(markdown).replace(RAW_FENCE_RE, (whole, ticks, info, body, close) => {
    if (info.trim()) return whole;
    const language = codeLanguageOrGeneric(inferCodeLanguage(body));
    const indent = whole.slice(0, whole.indexOf(ticks));
    return `${indent}${ticks}${language}\n${body}${close}`;
  });
}

// The raw-textarea equivalent of notesSelectionRange(): plain selected text
// (already markdown source, so no HTML→markdown conversion needed) plus its
// image count, counted from markdown image syntax since there's no DOM to
// query. If the selection is the inner lines of an existing fence (fence
// markers just outside the selected range), re-wraps it in that same fence
// + language so it doesn't turn into unfenced plain text on the new card.
export function notesEditSelectionText(target) {
  if (!isTargetEditing(target)) return "";
  const { selectionStart, selectionEnd, value } = target.edit;
  if (selectionStart === selectionEnd) return "";
  const raw = value.slice(selectionStart, selectionEnd);
  // Selection starts on a fence line: it already carries its own markers, so
  // it only needs a language stamped on any bare fence inside it.
  if (/^`{3,}/.test(raw.trim())) return withInferredFenceLanguages(raw);
  const fence = findRawCodeFence(value, selectionStart, selectionEnd);
  if (fence) return `\`\`\`${fence.language}\n${raw}\n\`\`\``;
  // Not inside a fence, but the selection may still CONTAIN whole ones.
  return withInferredFenceLanguages(raw);
}

// The current selection's markdown, regardless of which face (notes,
// question, answer) is active and whether it's viewed (rendered) or edited
// (raw) — shared by the floating pill and the persistent header buttons.
export function currentNotesSelectionMarkdown() {
  const editingTarget = activeEditingTarget();
  if (editingTarget) return notesEditSelectionText(editingTarget).trim();
  const renderedTarget = activeRenderedTarget();
  if (!renderedTarget) return "";
  const range = notesSelectionRange(renderedTarget);
  return range ? notesSelectionMarkdown(range, renderedTarget) : "";
}

// The same thing as PLAIN TEXT, for the pill's Copy / Share / Web search
// buttons. Those three replace Android's own selection bar, which the touch
// controller suppresses (see src/notes/touch-selection.js), and all three want
// the words rather than the markdown serialisation every other pill button
// works from — a search query with `**bold**` in it finds nothing, and nobody
// pastes a sentence into a message wanting the asterisks.
//
// Read through the RANGE and never through Selection.toString(): once the touch
// controller is armed the reading surfaces carry `user-select: none`, and Chrome
// answers Selection.toString() with "" over unselectable content while every
// Range operation on the same selection stays correct.
export function currentSelectionPlainText() {
  const editingTarget = activeEditingTarget();
  if (editingTarget) return notesEditSelectionText(editingTarget).trim();
  const renderedTarget = activeRenderedTarget();
  const range = renderedTarget ? notesSelectionRange(renderedTarget) : null;
  if (range) return range.toString().trim();
  // No live selection left — the pill's position-time snapshot, resolved on
  // demand exactly as every other pill action resolves it.
  ensurePillSelectionCapture();
  if (pillSelectionCapture && !pillSelectionCapture.editing) {
    return (pillSelectionCapture.sel?.asText || pillSelectionCapture.markdown || "").trim();
  }
  return "";
}

// ── When the pill is allowed to appear ─────────────────────────────────────
//
// Not while you are still choosing the words. A flat 160ms debounce on
// selectionchange put the bar on screen mid-drag — over the text being read, on
// a selection that was not finished — and then moved it again on every
// subsequent tick. It also meant the expensive capture below ran six times a
// second for the whole gesture.
//
// So the gesture is tracked, and the pill waits for the finger or the mouse
// button to come up. A keyboard selection (shift+arrow) has no gesture and is
// unaffected: it shows on the debounce exactly as before.
export let selectionGestureActive = false;

let gestureReleaseTimer = null;

// The browser places its own selection handles slightly after pointerup on
// touch, and the final `selectionchange` can arrive after the release. Long
// enough to let both land, short enough not to read as lag.
export const SELECTION_GESTURE_SETTLE_MS = 45;

// When the current gesture started, so one that never ended cannot suppress the
// pill for the rest of the session. A `pointerup` can genuinely go missing — a
// touch taken over by another surface, a pointer released over a element that
// was removed mid-gesture — and without this the bar simply stopped appearing,
// with no way back short of a reload. No real drag lasts this long.
export const SELECTION_GESTURE_MAX_MS = 5000;

let gestureStartedAt = 0;

export function selectionGestureIsLive() {
  if (!selectionGestureActive) return false;
  if (performance.now() - gestureStartedAt > SELECTION_GESTURE_MAX_MS) {
    selectionGestureActive = false;
    return false;
  }
  return true;
}

export function beginSelectionGesture() {
  selectionGestureActive = true;
  gestureStartedAt = performance.now();
  // The reader has put a finger down, so whatever the app had selected on their
  // behalf is no longer "ours" — see markProgrammaticNotesSelection.
  clearProgrammaticNotesSelection();
  if (gestureReleaseTimer) {
    clearTimeout(gestureReleaseTimer);
    gestureReleaseTimer = null;
  }
}

export function endSelectionGesture() {
  if (!selectionGestureActive) return;
  selectionGestureActive = false;
  if (gestureReleaseTimer) clearTimeout(gestureReleaseTimer);
  gestureReleaseTimer = setTimeout(() => {
    gestureReleaseTimer = null;
    positionNotesSelectionButton();
  }, SELECTION_GESTURE_SETTLE_MS);
}

// ── The half of the gesture the pointer events cannot see ──────────────────
//
// The tracker above suppresses everything expensive while a pointer is DOWN,
// and on a desktop that is the whole of a selection drag. On a phone it is not
// even half of one.
//
// Once a long press has produced a selection, the reader adjusts it by dragging
// the two handles — and on Android Chrome (and iOS Safari) those handles are
// BROWSER UI, drawn outside the page. Dragging one delivers no pointerdown, no
// pointermove and no pointerup to the document, so selectionGestureActive stays
// false for the entire adjustment and every guard keyed to it is simply absent.
//
// What that cost, stated precisely, because the obvious version of it is wrong:
// scheduleNotesSelectionCheck is a TRAILING debounce, so a smooth handle drag
// does not run the check once per event. It runs it whenever the events leave a
// 160ms gap — and the pass itself is what opens the gap. One pass is three
// clones of the selected fragment, two Turndown conversions, and an occurrence
// count that walks the rendered text of the whole note ABOVE the selection: the
// comment at the top of stringSink measures that at 218ms on a 2.6MB note,
// which is longer than the timer that scheduled it. So it self-oscillates at
// roughly 380ms for the whole drag, each pass re-describing a selection the
// reader is still moving, and each pass blocking the main thread for longer
// than a frame. The handle lags the finger, overshoots, and lands somewhere
// nobody aimed at.
//
// So the SELECTION ITSELF is the gesture signal, since the pointer isn't one: a
// burst of selectionchange events means someone is still moving something.
// Quiet for SELECTION_ADJUST_QUIET_MS means they have let go.
//
// Zero on a mouse, deliberately. The pointer tracker above already covers the
// desktop drag exactly, and adding a settle delay there would put a lag on a bar
// that has never felt laggy — tools/selection-check.mjs asserts the current
// timing.
export const SELECTION_ADJUST_QUIET_MS = 300;

export const coarsePointerMedia = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(pointer: coarse)")
  : null;

export function selectionAdjustQuietMs() {
  return coarsePointerMedia?.matches ? SELECTION_ADJUST_QUIET_MS : 0;
}

let selectionChangedAt = 0;

// ── When the app itself owns the drag ──────────────────────────────────────
//
// Everything above infers "a handle is still moving" from a burst of
// selectionchange events, because a NATIVE handle is browser UI and sends no
// pointer events. src/notes/touch-selection.js draws its own handles, so on
// that path the inference is replaced by the fact: it says when a drag starts
// and when it ends.
//
// Clearing the flag also expires the quiet window, so the pill appears the
// instant a finger lifts rather than 300ms later. That delay was never a
// feature — it was the cost of not knowing.
let touchSelectionDragging = false;

// ...and whether that module is in charge at all. When it is, a selectionchange
// is OUR OWN MIRROR of a gesture we are already tracking — never the only trace
// of a native handle, which is the single thing the quiet window was invented to
// notice. Leaving the inference running alongside the fact was not merely
// redundant, it was a race: selectionchange is delivered asynchronously, so the
// last mirror of a drag lands AFTER the touchend that ended it, re-stamping the
// clock and holding the pill back for another 300ms — intermittently, depending
// on where the event queue fell. Measured: the bar failed to appear on roughly
// two runs in three.
let touchSelectionArmed = false;

export function setTouchSelectionArmed(active) {
  touchSelectionArmed = Boolean(active);
  selectionChangedAt = 0;
}

export function setTouchSelectionDragging(active) {
  touchSelectionDragging = Boolean(active);
  if (!touchSelectionDragging) selectionChangedAt = 0;
}

// Is a finger on a selection handle RIGHT NOW? Read by settleNotesPin, which
// must not write scrollTop under a live gesture. Exposed from here rather than
// from touch-selection.js so notes-view.js gains no new module edge — this is
// where the flag already lives.
export function touchSelectionDragActive() {
  return touchSelectionDragging;
}

// A selection being ADJUSTED, as opposed to one that is finished and sitting
// still. Non-collapsed on purpose: collapsing to a caret is an ending, not a
// step, and treating it as "still moving" would hold the pill's dismissal for
// another 300ms every time a reader tapped to clear.
export function isSelectionAdjusting() {
  if (touchSelectionDragging) return true;
  // Armed and not dragging means the gesture is OVER, on the authority of the
  // module that ran it. Falling through to the quiet window here is what let a
  // trailing mirror event re-open a drag that had already finished.
  if (touchSelectionArmed) return false;
  const quiet = selectionAdjustQuietMs();
  if (!quiet) return false;
  if (performance.now() - selectionChangedAt >= quiet) return false;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount);
}

// ── Keeping the text still while a handle is on it ─────────────────────────
//
// styles/12-notes.css:256 gives every top-level notes block
// `content-visibility: auto`, and styles/19-notes-chunks.css:31 does the same
// per chunk with a 4800px placeholder. Off-screen content is not laid out, so
// until it is first rendered its height is that ESTIMATE — and the moment a
// handle drag reaches it, the estimate is replaced by the real height and
// everything below moves. The handle is then over different words than the
// finger was aiming at, which is the "indicators are almost always wrong" half
// of the report.
//
// Suspending containment fixes it, and suspending it EVERYWHERE would be worse
// than the bug: a full layout of a 24,600-block note is the exact cost
// 19-notes-chunks.css was written to avoid (122ms per frame, measured there),
// and it would land on the frame the reader is dragging in. So only the chunk
// under the selection and its two neighbours are freed — about 14,000px of
// estimated reach either side, which is more than one drag can cross.
//
// A note below NOTES_CHUNK_MIN_BLOCKS has no chunks; there the same region is
// marked one level down, on the BLOCKS themselves. See styles/31-touch-selection.css
// for both selectors and why each has to out-specify the rule it overrides.
export const SELECTION_STABLE_CLASS = "is-selection-stable";

let stableChunks = [];

export function clearSelectionStableRegion() {
  // Cheap "already clear" test first. positionNotesSelectionButton calls this on
  // every pass, including every desktop one, where nothing was ever marked —
  // that must not cost four DOM writes. (Same shape as the fast path at the top
  // of hideNotesSelectionButton, and for the same reason.)
  if (!stableChunks.length && !document.body.classList.contains("is-selecting")) return;
  stableChunks.forEach((chunk) => chunk.classList.remove(SELECTION_STABLE_CLASS));
  stableChunks = [];
  // (`stableChunks` holds blocks rather than chunks on a note too short to have
  // any — see markSelectionStableRegion. The class and the clearing are the same
  // either way, which is why there is one list and not two.)
  //
  // Handing containment back does NOT shift the layout a second time: the
  // estimates are written `contain-intrinsic-size: auto <fallback>`, and the
  // `auto` keyword means a block that has been rendered once remembers its real
  // size. The fallback only ever applies to content that has never been on
  // screen — which, by the time this runs, this content has.
  //
  // For a CHUNK that is now true by construction rather than by argument:
  // pinChunkHeights measured each one and pinned its real height before the
  // class went on, so containment off and containment on describe the same box.
  // Before that they did not, and this is the moment a highlight's own repaint
  // used to inherit a displacement the pin loop then spent 400ms chasing.
  document.body.classList.remove("is-selecting");
}

// The top-level BLOCK a selection boundary sits in, or null — the same question
// chunkForSelectionNode asks one level down, for a note too short to have chunks.
export function blockForSelectionNode(view, node) {
  if (!node || !view.contains(node)) return null;
  // `up`, not `el`: this module imports `el` (the DOM handle registry), and a
  // local of that name shadows it — which the module scanner correctly refuses.
  let up = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (up && up !== view && up.parentElement !== view) up = up.parentElement;
  return up && up !== view && up.parentElement === view ? up : null;
}

// The chunk a selection boundary sits in, or null.
export function chunkForSelectionNode(view, node) {
  if (!node || !view.contains(node)) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const chunk = element?.closest?.(".notes-chunk");
  return chunk && chunk.parentElement === view ? chunk : null;
}

// `growOnly` is for a live drag. Without it the wanted set REPLACES the marked
// one on every step, so a boundary leaving a chunk hands that chunk its
// containment back mid-gesture — a class write, and therefore a style
// invalidation over every block inside it, on the frame the reader is dragging
// in. Nothing is gained by it: the region is dropped wholesale by
// clearSelectionStableRegion() when the finger lifts, a few hundred
// milliseconds later. The cap is what stops a drag the length of a book from
// freeing the whole document one chunk at a time.
export const SELECTION_STABLE_MAX_CHUNKS = 8;

// ── Freeing containment must not itself move the page ──────────────────────
//
// Suspending `content-visibility` on a chunk is the fix above. It is also, on
// its own, the very bug it is fixing: a chunk that has never been laid out is
// standing at its `contain-intrinsic-size` ESTIMATE, and the moment containment
// comes off it takes its real height instead. A chunk above the viewport doing
// that moves everything below it — including the words under the reader's
// finger, and including the ones the pin loop is about to measure after a
// highlight. So the region was steadied by an operation that lurched the page.
//
// measureNotesChunkEstimate (src/render/block-cache.js) already solves exactly
// this: it forces one chunk to lay out, reads its real height and pins that as
// its own contain-intrinsic-size, after which containment on and off are the
// same height. It was only ever driven by an IntersectionObserver with a 1200px
// runway, so a drag that outruns the runway — or a NEIGHBOUR chunk the observer
// never had a reason to look at — still met an unmeasured one.
//
// Measuring here closes that. It has to happen BEFORE the class is written, in
// the same task: the measurement and the class write then land in one paint, so
// there is no frame in which the chunk is uncontained at a height nobody has
// pinned. Idempotent (a WeakSet guards it), so repeating it per drag frame costs
// a lookup.
// ── ...but only for chunks at or below the fold ────────────────────────────
//
// Pinning is not free for a chunk sitting ABOVE the viewport: swapping its
// guessed placeholder for its real height changes the document above the reader,
// and everything below it — the reader included — moves by the difference. The
// browser's scroll anchoring absorbs that, and adding a correction on top of it
// double-counts (measured: a 63px drift became 337px the other way). So the
// answer is not to correct the jump but not to cause it: measure the chunks the
// gesture is travelling INTO, and leave the ones behind it alone.
//
// Nothing is lost by that. A drag extends downward far more often than upward,
// the containment suspension still covers both directions, and a chunk above the
// reader gets measured the ordinary way — by the estimate observer, as they
// scroll back through it.
export function pinChunkHeights(chunks) {
  const view = el.notesView;
  if (!view) return;
  const bounds = view.getBoundingClientRect();
  chunks.forEach((chunk) => {
    if (!chunk?.isConnected) return;
    if (chunk.getBoundingClientRect().bottom <= bounds.top) return;
    measureNotesChunkEstimate(chunk);
  });
}

// One chunk further out than the region actually being freed, measured but not
// uncontained. That is the runway: by the time a drag crosses INTO one of these
// its height is already pinned, so the crossing costs a class write rather than
// a re-layout plus a lurch. Only computed when the region changed, which on a
// drag is exactly the frames that cross a chunk boundary.
export function chunkRunwayFor(chunks) {
  const runway = [];
  chunks.forEach((chunk) => {
    [chunk.previousElementSibling, chunk.nextElementSibling].forEach((neighbour) => {
      if (neighbour && neighbour.classList?.contains("notes-chunk")
          && !chunks.includes(neighbour) && !runway.includes(neighbour)) {
        runway.push(neighbour);
      }
    });
  });
  return runway;
}

export function markSelectionStableRegion({ growOnly = false } = {}) {
  const view = el.notesView;
  if (!view) return;
  const selection = window.getSelection();
  // Nothing selected, or selected somewhere that is not the notes — a card
  // face, a textarea, a panel. There is no containment to suspend for any of
  // those, and marking the view would be wrong for all of them.
  if (!selection || !selection.rangeCount
      || (!view.contains(selection.anchorNode) && !view.contains(selection.focusNode))) {
    clearSelectionStableRegion();
    return;
  }
  // BOTH boundaries, not just the anchor. Adjusting a selection by its end
  // handle leaves the anchor exactly where it was — so an anchor-only version
  // freed the chunk the reader had already finished with and never the one they
  // were dragging into, which is the only one that matters. The two are the same
  // chunk for a short selection and the set below de-duplicates.
  const anchorChunk = chunkForSelectionNode(view, selection.anchorNode);
  const focusChunk = chunkForSelectionNode(view, selection.focusNode);
  const wanted = [];
  // Each boundary's own chunk plus one either side. previousElementSibling
  // rather than an index walk because a chunked note's children are all chunks —
  // the block-cache builds them that way — and this stays correct if that ever
  // stops being true.
  [anchorChunk, focusChunk].forEach((chunk) => {
    if (!chunk) return;
    [chunk.previousElementSibling, chunk, chunk.nextElementSibling].forEach((neighbour) => {
      if (neighbour && neighbour.classList?.contains("notes-chunk") && !wanted.includes(neighbour)) {
        wanted.push(neighbour);
      }
    });
  });
  // ── No chunks: the same region, one level down ───────────────────────────
  //
  // A note under NOTES_CHUNK_MIN_BLOCKS has no chunk wrappers, and this used to
  // answer that by freeing `content-visibility` across the WHOLE view
  // (is-selection-unchunked). Every block in the note that had never been
  // painted then jumped from --notes-block-estimate to its real height at once,
  // at the start of the gesture — including the blocks above the reader, which
  // is the half that moves the page. "Small enough to afford it" was true of the
  // layout cost and not of the displacement.
  //
  // The region idea works here unchanged: the blocks under the two boundaries
  // plus one either side. Bounded, near the reader, and pinned below.
  if (!wanted.length) {
    [selection.anchorNode, selection.focusNode].forEach((node) => {
      const block = blockForSelectionNode(view, node);
      if (!block) return;
      [block.previousElementSibling, block, block.nextElementSibling].forEach((neighbour) => {
        if (neighbour && neighbour.nodeType === Node.ELEMENT_NODE && !wanted.includes(neighbour)) {
          wanted.push(neighbour);
        }
      });
    });
  }
  // Mid-drag: keep what is already free as well as what is wanted now, up to
  // the cap. Past the cap this falls back to replacing, which is the old
  // behaviour and the right one for a gesture that has travelled far enough to
  // reach it.
  if (growOnly && wanted.length && stableChunks.length + wanted.length <= SELECTION_STABLE_MAX_CHUNKS) {
    stableChunks.forEach((chunkEl) => {
      if (chunkEl.isConnected && !wanted.includes(chunkEl)) wanted.push(chunkEl);
    });
  }
  // Same-set check before touching the DOM: this runs on every selectionchange
  // during a drag, and a class write on a chunk is a style invalidation over
  // everything inside it. Order-insensitive, because which boundary is the
  // anchor and which the focus flips the moment a drag crosses its own starting
  // point — and that must not read as a different region.
  const unchanged = wanted.length === stableChunks.length
    && wanted.every((chunkEl) => stableChunks.includes(chunkEl));
  if (!unchanged) {
    // Heights first, classes second, one task — see pinChunkHeights. The runway
    // is measured in the same pass because a drag that has just changed region
    // is a drag that is travelling, and the next chunk it reaches should already
    // be pinned when it gets there.
    pinChunkHeights(wanted);
    pinChunkHeights(chunkRunwayFor(wanted));
    stableChunks.forEach((old) => {
      if (!wanted.includes(old)) old.classList.remove(SELECTION_STABLE_CLASS);
    });
    wanted.forEach((chunkEl) => chunkEl.classList.add(SELECTION_STABLE_CLASS));
    stableChunks = wanted;
  }
  document.body.classList.add("is-selecting");
}

// Called from the document's `selectionchange` listener, ahead of the debounce.
// Stamping the clock and freeing the containment both have to happen on the
// EVENT, not on the debounced check — the whole point is to be ready before the
// next drag frame, and the debounced check is the thing being deferred.
export function noteSelectionChanged() {
  // The CLOCK is the only thing the touch controller takes over here. Stamping
  // it from an event that is merely an echo of its own mirror is the race
  // described above setTouchSelectionArmed — but the containment region still
  // has to follow the selection, because a drag carries a boundary into a chunk
  // that has never been laid out at any point during the gesture, not only at
  // the moment it starts.
  if (!touchSelectionArmed) {
    if (!selectionAdjustQuietMs()) return;
    selectionChangedAt = performance.now();
  }
  // growOnly while the app owns the drag. Every selectionchange during one is
  // an echo of the controller's own mirror, arriving a frame or so after the
  // controller has already marked the region for that step — and the REPLACING
  // version of this pass undid that marking, handing a chunk its containment
  // back and taking it away again as the boundary moved over it. Two class
  // writes over everything in a chunk, per frame, for nothing.
  if (isSelectionAdjusting()) markSelectionStableRegion({ growOnly: touchSelectionDragging });
  else clearSelectionStableRegion();
}

// Does the range contain an image? Only asked when the range has no text, so
// the clone is paid for by a selection that is a picture and nothing else.
export function rangeHasImage(range) {
  try {
    const node = range.commonAncestorContainer;
    const host = node.nodeType === 1 ? node : node.parentElement;
    if (!host?.querySelector?.("img")) return false;
    return range.cloneContents().querySelector("img") !== null;
  } catch (_) {
    return false;
  }
}

// The four parts of a Range, kept on the capture so a second pass over the SAME
// selection can be recognised and skipped. See the guard in
// positionNotesSelectionButton for why there is a second pass at all.
export function rangeBoundaries(range) {
  return {
    startContainer: range.startContainer,
    startOffset: range.startOffset,
    endContainer: range.endContainer,
    endOffset: range.endOffset,
  };
}

export function sameRangeBoundaries(at, range) {
  if (!at || !range) return false;
  return at.startContainer === range.startContainer && at.startOffset === range.startOffset
    && at.endContainer === range.endContainer && at.endOffset === range.endOffset;
}

let pillCaptureTimer = null;

// Fill in the expensive half of the capture. Idempotent, and safe to call from
// a button handler: if the scheduled pass has not run yet this does it now,
// which is still while the selection is alive because a press cannot precede
// the release that showed the bar.
export function ensurePillSelectionCapture() {
  if (!pillSelectionCapture?.pending) return pillSelectionCapture;
  const target = SELECTION_TARGETS.find((t) => t.name === pillSelectionCapture.targetName);
  const range = target ? notesSelectionRange(target) : null;
  if (!range) {
    // The selection went away before we could describe it. Leave `pending` set
    // rather than writing nulls in as though they were an answer.
    return pillSelectionCapture;
  }
  // Described once, used twice — see notesSelectionMarkdown's third argument.
  const described = renderedSelectionStrings(target.view);
  const markdown = notesSelectionMarkdown(range, target, described);
  pillSelectionCapture.sel = described;
  pillSelectionCapture.markdown = markdown;
  pillSelectionCapture.pending = false;
  if (el.makeCardFromSelectionBtn) {
    el.makeCardFromSelectionBtn.dataset.selectionText = markdown;
    const words = range.toString().trim().split(/\s+/).filter(Boolean).length;
    el.makeCardFromSelectionBtn.title = words ? `Make a card · ${words} word${words === 1 ? "" : "s"}` : "Make a card";
  }
  return pillSelectionCapture;
}

export function schedulePillSelectionCapture() {
  if (pillCaptureTimer) clearTimeout(pillCaptureTimer);
  // A timeout, not an idle callback: this has to land before the reader can
  // press anything, and requestIdleCallback can be several hundred ms away on a
  // busy tab — which is exactly the tab this runs in.
  pillCaptureTimer = setTimeout(() => {
    pillCaptureTimer = null;
    ensurePillSelectionCapture();
  }, 0);
}

export const NOTES_SELECTION_DEBOUNCE_MS = 160;

export function scheduleNotesSelectionCheck() {
  if (notesSelectionTimer) clearTimeout(notesSelectionTimer);
  // On touch the debounce is the quiet window, not a flat 160ms: every
  // selectionchange re-arms it, so the expensive pass runs ONCE, after the
  // reader lets go of the handle, instead of once per 160ms for the whole
  // adjustment. See SELECTION_ADJUST_QUIET_MS. A mouse keeps the 160ms it has
  // always had — selectionAdjustQuietMs() is 0 there.
  const delay = Math.max(NOTES_SELECTION_DEBOUNCE_MS, selectionAdjustQuietMs());
  notesSelectionTimer = setTimeout(positionNotesSelectionButton, delay);
}

// Textareas have no native API for "where on screen is this selection" (the
// rendered view gets that for free from Range.getBoundingClientRect()) — this
// is the standard workaround: clone the textarea's box/font metrics into an
// offscreen mirror div, split its text at the selection boundaries with
// marker spans, and read the spans' positions back out. Returns a viewport-
// relative rect, same shape as getBoundingClientRect().
// Above this the mirror is skipped entirely. It lays out a SECOND full copy of
// the document — the exact cost HIGHLIGHT_MIRROR_MAX_CHARS exists to avoid for
// the syntax-highlight backdrop (see the block comment there) — except this one
// had no guard at all, and it runs on every selection change (160ms debounce)
// while you drag a selection. On a book-sized note that is a full document
// layout six times a second.
//
// The fallback estimates the caret's line from line-height arithmetic, the same
// approximation scrollTextareaToOffset already trusts in both directions. It is
// off for wrapped lines, but the caller clamps the button into the editor's box
// anyway, so the worst case is a button a little above or below the selection
// rather than a frozen tab.
export function estimatedTextareaSelectionRect(textarea) {
  const { selectionStart, value } = textarea;
  const rect = textarea.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
  const y = rect.top + lineIndexAtOffset(value, selectionStart) * lineHeight - textarea.scrollTop;
  return {
    top: y,
    bottom: y + lineHeight,
    left: rect.left,
    right: rect.right,
  };
}

export function textareaSelectionRect(textarea) {
  const { selectionStart, selectionEnd, value } = textarea;
  if (value.length > HIGHLIGHT_MIRROR_MAX_CHARS) return estimatedTextareaSelectionRect(textarea);
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  [
    "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
    "textTransform", "wordSpacing", "tabSize", "wordBreak",
  ].forEach((prop) => { mirror.style[prop] = style[prop]; });
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.height = "auto";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";

  const markerStart = document.createElement("span");
  markerStart.textContent = "​";
  const markerEnd = document.createElement("span");
  markerEnd.textContent = "​";
  mirror.append(
    document.createTextNode(value.slice(0, selectionStart)),
    markerStart,
    document.createTextNode(value.slice(selectionStart, selectionEnd)),
    markerEnd,
    document.createTextNode(value.slice(selectionEnd))
  );
  document.body.appendChild(mirror);

  const textareaRect = textarea.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();
  const startRect = markerStart.getBoundingClientRect();
  const endRect = markerEnd.getBoundingClientRect();
  mirror.remove();

  const toViewport = (r) => ({
    top: textareaRect.top + (r.top - mirrorRect.top) - textarea.scrollTop,
    bottom: textareaRect.top + (r.bottom - mirrorRect.top) - textarea.scrollTop,
    left: textareaRect.left + (r.left - mirrorRect.left) - textarea.scrollLeft,
    right: textareaRect.left + (r.right - mirrorRect.left) - textarea.scrollLeft,
  });
  const start = toViewport(startRect);
  const end = toViewport(endRect);
  return {
    top: Math.min(start.top, end.top),
    bottom: Math.max(start.bottom, end.bottom),
    left: Math.min(start.left, end.left),
    right: Math.max(start.right, end.right),
  };
}

// On narrow/touch screens, reaching past the visible edge of a big selection
// means dragging a handle until the view auto-scrolls (or scrolling by hand
// mid-selection) — the selection's bounding rect then spans more than one
// screen, and pinning the button to its top/bottom edge can put it anywhere
// from the very top of the screen to the very bottom depending on which edge
// is currently on-screen. Anchor it to a fixed spot instead: always the same
// thumb-reachable place, regardless of how big the selection is or where it
// scrolled to. Desktop keeps the precise follow-the-selection positioning
// below, since dragging with a mouse doesn't hit the same problem.
export function pinSelectionButtonToBottom(button) {
  button.style.top = "";
  button.style.left = "";
  button.classList.add("is-pinned-bottom");
}

export function positionNotesSelectionButton() {
  // `button` is the floater CONTAINER (positioning + show/hide operate on it);
  // `cardBtn` is the "make card" button that carries the captured selection.
  const button = el.selectionFloat;
  const cardBtn = el.makeCardFromSelectionBtn;
  if (!button || !cardBtn) return;
  // Still dragging. Everything below is either a DOM write the reader would see
  // (the bar appearing over the words they are choosing) or the expensive
  // capture — three clones of the selected fragment, two Turndown runs, and an
  // occurrence count that walks the note above the selection. At six ticks a
  // second on a book-sized note that is why a long-press took so long to start
  // a selection at all: the main thread was busy describing the last one.
  // endSelectionGesture() calls back in once the pointer is up.
  if (selectionGestureIsLive()) {
    if (!button.hidden) hideNotesSelectionButton();
    return;
  }
  // Still dragging a native selection HANDLE, which sends no pointer events at
  // all — so the guard above cannot see it and this one has to. Same treatment
  // for the same reason: no DOM writes the reader would notice, and none of the
  // expensive capture, until the selection stops moving. See
  // isSelectionAdjusting(). The re-armed debounce in scheduleNotesSelectionCheck
  // is what calls back in once it does; this is the belt to that braces, for a
  // check that was already in flight when the drag started.
  if (isSelectionAdjusting()) {
    if (!button.hidden) hideNotesSelectionButton();
    return;
  }
  // The adjustment is over: hand the containment back before anything below
  // measures a rect, so the pill is placed against the layout the reader will
  // actually see.
  clearSelectionStableRegion();
  // A selection the APP made, to show the reader where a jump landed. It is a
  // real Selection and fires a real selectionchange, but nobody asked for a
  // formatting bar over it — see markProgrammaticNotesSelection. The window is
  // short and any pointerdown ends it, so a reader who does then reach for the
  // pill gets it on their next selectionchange.
  if (isProgrammaticNotesSelection()) {
    if (!button.hidden) hideNotesSelectionButton();
    return;
  }
  const mobile = Boolean(styleMobileMedia?.matches);
  if (!mobile) button.classList.remove("is-pinned-bottom");

  const editingTarget = activeEditingTarget();
  if (editingTarget) {
    const raw = notesEditSelectionText(editingTarget);
    const text = raw.trim();
    if (!text) {
      hideNotesSelectionButton();
      return;
    }
    cardBtn.dataset.selectionText = text;
    const words = text.split(/\s+/).filter(Boolean).length;
    const imageMatches = text.match(/!\[[^\]]*\]\([^)]*\)/g) || [];
    const parts = [];
    if (words) parts.push(`${words} word${words === 1 ? "" : "s"}`);
    if (imageMatches.length) parts.push(imageMatches.length === 1 ? "1 image" : `${imageMatches.length} images`);
    cardBtn.title = `Make a card${parts.length ? ` · ${parts.join(" + ")}` : ""}`;
    // Raw-edit mode: the pill's highlight/erase work there too now (see the
    // pointerdown handlers — textarea selections survive a pill tap, so those
    // read the live [start,end) directly; this capture only records WHICH
    // editor holds the selection).
    pillSelectionCapture = { targetName: editingTarget.name, editing: true, sel: null, markdown: text };
    // The pill now carries the inline formatting controls, and those are driven
    // by the shared [data-render-action] delegation, which reads the target off
    // the nearest [data-render-target] ancestor. The pill serves the notes AND
    // both card faces, so that target is whichever surface this selection is
    // in — not a constant.
    button.dataset.renderTarget = editingTarget.name;
    // ...and the formatting slot too, now. These controls used to be hidden
    // here: they located the selection by matching the RENDERED text
    // (renderedSelectionStrings), which a textarea has none of, so in raw mode
    // they silently did nothing and the raw editor's own toolbar was the answer
    // instead. applyRenderFormat now takes the textarea's exact offsets when the
    // surface is being edited, so the same buttons work in both modes — which is
    // what let that toolbar shrink to the three controls a selection can't
    // express (insert image, bullet, clear formatting).
    if (el.selectionFloatFormat) el.selectionFloatFormat.hidden = false;
    if (el.eraseNotesSelectionBtn) el.eraseNotesSelectionBtn.hidden = false;
    if (el.highlightSelectionBtn) el.highlightSelectionBtn.hidden = false;
    // Splitting text into its own note only makes sense from a note. A card
    // face would end up with a link on it that you cannot follow while
    // studying, so the button is simply not offered there.
    if (el.extractNoteFromSelectionBtn) el.extractNoteFromSelectionBtn.hidden = editingTarget.name !== "notes";
    button.hidden = false;
    if (mobile) return pinSelectionButtonToBottom(button);
    // Track the actual selection (same approach as the rendered-view branch
    // below) instead of parking in the textarea's corner regardless of where
    // the selection actually is.
    const selRect = textareaSelectionRect(editingTarget.edit);
    const editRect = editingTarget.edit.getBoundingClientRect();
    const btnRect = button.getBoundingClientRect();
    const margin = 8;
    // Above by preference, same as the rendered branch (see
    // placeSelectionPillNearRange) — a bar under the selection covers the lines
    // being written toward.
    let top = selRect.top - btnRect.height - margin;
    if (top < margin || top < editRect.top) top = selRect.bottom + margin;
    top = Math.min(Math.max(top, editRect.top + margin), editRect.bottom - btnRect.height - margin);
    const left = Math.min(
      Math.max(margin, selRect.left + (selRect.right - selRect.left) / 2 - btnRect.width / 2),
      window.innerWidth - btnRect.width - margin
    );
    button.style.top = `${top}px`;
    button.style.left = `${Math.max(margin, left)}px`;
    return;
  }

  const renderedTarget = activeRenderedTarget();
  const range = renderedTarget ? notesSelectionRange(renderedTarget) : null;
  // CHEAP emptiness test. This used to be cleanedSelectionFragment().textContent
  // — a clone of the selection plus its table/list repair — just to answer "is
  // there anything selected", which is what Range.toString() answers for free.
  const quickText = range ? range.toString().trim() : "";
  if (!range || (!quickText && !rangeHasImage(range))) {
    hideNotesSelectionButton();
    return;
  }

  // ── Show first, describe afterwards ──────────────────────────────────────
  //
  // Everything the pill's BUTTONS need — the markdown serialisation, the
  // occurrence count, the word tally — used to be computed here, before
  // `button.hidden = false`. That is three clones of the selected fragment, two
  // Turndown conversions, and an occurrence count that clones the whole note
  // above the selection, all on the path between letting go of the mouse and
  // the bar appearing. On a book it is the entire reason the bar felt late.
  //
  // None of it is needed to DRAW the bar. The capture is scheduled immediately
  // afterwards instead, and any button pressed before it lands resolves it on
  // the spot (see ensurePillSelectionCapture) — so the snapshot is still taken
  // while the selection is alive, which is the reason it exists.
  // ── ...but only once per selection ───────────────────────────────────────
  //
  // One finished touch selection reaches here three times: endDrag() calls in
  // the moment the finger lifts, endSelectionGesture()'s settle timer calls in
  // 45ms later on the pointerup, and the trailing selectionchange — the last
  // mirror of the drag, delivered asynchronously — calls in again on the 300ms
  // debounce. Each pass threw the capture away and scheduled it afresh, so the
  // expensive half (three clones of the fragment, two Turndown runs, an
  // occurrence count over the note above the selection) ran three times over
  // an identical range, in the first third of a second after the reader let go.
  // On a long note that is three long tasks back to back, which is felt as the
  // app hitching just as the bar arrives.
  //
  // Nothing about an unchanged selection needs re-describing, and leaving the
  // pill exactly as it is also removes the hide-then-show blink when the first
  // of those three passes lands while the gesture still reads as live.
  if (!button.hidden
      && button.dataset.renderTarget === renderedTarget.name
      && pillSelectionCapture
      && !pillSelectionCapture.editing
      && sameRangeBoundaries(pillSelectionCapture.at, range)) {
    return;
  }
  pillSelectionCapture = {
    targetName: renderedTarget.name,
    editing: false,
    sel: null,
    markdown: null,
    pending: true,
    at: rangeBoundaries(range),
  };
  cardBtn.title = "Make a card";
  schedulePillSelectionCapture();
  button.dataset.renderTarget = renderedTarget.name;
  if (el.selectionFloatFormat) el.selectionFloatFormat.hidden = false;
  // Highlight and erase work for every rendered face (notes AND card
  // question/answer — renderTargetConfig handles all three). Splitting out a
  // sub-note does not: see the editing branch above.
  if (el.eraseNotesSelectionBtn) el.eraseNotesSelectionBtn.hidden = false;
  if (el.highlightSelectionBtn) el.highlightSelectionBtn.hidden = false;
  if (el.extractNoteFromSelectionBtn) el.extractNoteFromSelectionBtn.hidden = renderedTarget.name !== "notes";
  button.hidden = false;
  if (mobile) return pinSelectionButtonToBottom(button);
  placeSelectionPillNearRange(button, range);
}

// Above the selection by preference, below only when there is no room.
//
// This used to be the other way round — `rect.bottom + margin`, flipping up only
// when the bar would fall off the bottom of the window — which put a bar of
// twelve controls directly over the lines you were about to read next. Reading
// runs downward, so the space a reader has already used is the safer place to
// cover.
//
// The horizontal anchor is the LAST client rect, not the union's centre. A
// selection spanning several lines has a union as wide as the column, whose
// centre has nothing to do with where the drag ended; anchoring to the final
// fragment puts the bar next to the words the pointer just left.
export function placeSelectionPillNearRange(button, range) {
  const rects = range.getClientRects();
  const union = range.getBoundingClientRect();
  const last = rects.length ? rects[rects.length - 1] : union;
  const btnRect = button.getBoundingClientRect();
  const margin = 8;

  let top = union.top - btnRect.height - margin;
  if (top < margin) {
    // No room above — go below, and clamp into the window rather than off it.
    top = Math.min(union.bottom + margin, window.innerHeight - btnRect.height - margin);
    top = Math.max(margin, top);
  }
  const anchorX = last.left + last.width / 2;
  const left = Math.min(
    Math.max(margin, anchorX - btnRect.width / 2),
    Math.max(margin, window.innerWidth - btnRect.width - margin)
  );
  button.style.top = `${top}px`;
  button.style.left = `${left}px`;
}
