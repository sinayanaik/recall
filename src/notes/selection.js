// Turning a selection in the RENDERED note back into markdown.
//
// The hard part is that a rendered selection has no source: it is matched back
// by text, and partial selections of atomic blocks (tables, list items, code
// fences) have to be repaired into something that still parses. A code
// selection is re-fenced off the <pre>, not the <code>, because the language
// lives on the parent.

import { el } from "../core/dom.js?v=__BUILD__";
import { renderedSelectionStrings } from "../format/locate-selection.js?v=__BUILD__";
import { htmlToMarkdown } from "../import/html-to-markdown.js?v=__BUILD__";
import { HIGHLIGHT_MIRROR_MAX_CHARS, state } from "../main.js?v=__BUILD__";
import { lineIndexAtOffset } from "./caret.js?v=__BUILD__";
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
  if (el.selectionFloat?.hidden
      && !pillSelectionCapture
      && el.highlightSelectionMenu?.hidden !== false) {
    return;
  }
  if (el.selectionFloat) el.selectionFloat.hidden = true;
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

export function textWithLineBreaks(node) {
  let text = "";
  let prevBlockTag = null;
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.data;
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    if (child.tagName === "BR") {
      text += "\n";
      return;
    }
    // KaTeX emits every formula TWICE: a hidden MathML tree for screen readers
    // and the visible glyph spans. Descending into both doubles every symbol.
    // Skipped even where there's no data-tex host to short-circuit on, so math
    // from the \[…\] auto-render safety net comes back single, not doubled.
    if (child.classList?.contains("katex-mathml")) return;
    // Mermaid inlines a stylesheet into its SVG; reading it as text emits the
    // whole thing as a wall of CSS.
    if (child.tagName === "STYLE" || child.tagName === "SCRIPT") return;
    const isTight = TIGHT_BLOCK_TAGS.has(child.tagName);
    const isLoose = LOOSE_BLOCK_TAGS.has(child.tagName);
    if ((isTight || isLoose) && text) {
      const gap = isTight && prevBlockTag === "LI" ? "\n" : "\n\n";
      if (!text.endsWith(gap)) text = text.replace(/\n+$/, "") + gap;
    }
    // A rendered formula or diagram reads back as its own source, not as its
    // glyphs/SVG — the gap handling above still runs (both are <div>s at block
    // level, loose blocks), but the descent doesn't. This string is what
    // locateSelectionInSource hunts for in the raw markdown, so walking the
    // KaTeX tree instead emitted characters that appear nowhere in the source,
    // which is why highlighting, clozing, erasing and a card's "go to notes"
    // anchor all silently missed on any selection containing math.
    const atomicSource = atomicSourceForNode(child);
    text += atomicSource || textWithLineBreaks(child);
    if (isTight || isLoose) prevBlockTag = child.tagName;
  });
  return text;
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
export function notesSelectionMarkdown(range, target) {
  const codeFence = notesSelectionCodeFence(range, target);
  if (codeFence) return codeFence;
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

export function scheduleNotesSelectionCheck() {
  if (notesSelectionTimer) clearTimeout(notesSelectionTimer);
  notesSelectionTimer = setTimeout(positionNotesSelectionButton, 160);
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
    let top = selRect.bottom + margin;
    if (top + btnRect.height > window.innerHeight - margin) {
      top = Math.max(margin, selRect.top - btnRect.height - margin);
    }
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
  const fragment = range ? cleanedSelectionFragment(range) : null;
  const text = fragment ? fragment.textContent.trim() : "";
  const imageCount = fragment ? fragment.querySelectorAll("img").length : 0;
  if (!text && !imageCount) {
    hideNotesSelectionButton();
    return;
  }
  // Capture the selection as markdown now: tapping the button may dissolve
  // the selection before the click handler runs.
  cardBtn.dataset.selectionText = notesSelectionMarkdown(range, renderedTarget);
  // Reflect how much is being captured in the tooltip (the button itself is
  // icon-only now, so the count lives on hover/long-press instead of inline).
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const parts = [];
  if (words) parts.push(`${words} word${words === 1 ? "" : "s"}`);
  if (imageCount) parts.push(imageCount === 1 ? "1 image" : `${imageCount} images`);
  cardBtn.title = `Make a card${parts.length ? ` · ${parts.join(" + ")}` : ""}`;
  // Snapshot everything the pill's buttons will need — tapping one can kill
  // the live selection before its handler reads it (mobile).
  pillSelectionCapture = {
    targetName: renderedTarget.name,
    editing: false,
    sel: renderedSelectionStrings(renderedTarget.view),
    markdown: cardBtn.dataset.selectionText,
  };
  // Highlight and erase work for every rendered face (notes AND card
  // question/answer — renderTargetConfig handles all three). Splitting out a
  // sub-note does not: see the editing branch above.
  if (el.eraseNotesSelectionBtn) el.eraseNotesSelectionBtn.hidden = false;
  if (el.highlightSelectionBtn) el.highlightSelectionBtn.hidden = false;
  if (el.extractNoteFromSelectionBtn) el.extractNoteFromSelectionBtn.hidden = renderedTarget.name !== "notes";
  button.hidden = false;
  if (mobile) return pinSelectionButtonToBottom(button);
  const rect = range.getBoundingClientRect();
  const btnRect = button.getBoundingClientRect();
  const margin = 8;
  let top = rect.bottom + margin;
  if (top + btnRect.height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - btnRect.height - margin);
  }
  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - btnRect.width / 2),
    window.innerWidth - btnRect.width - margin
  );
  button.style.top = `${top}px`;
  button.style.left = `${left}px`;
}
