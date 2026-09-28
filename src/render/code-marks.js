// Highlights INSIDE a code block.
//
// A highlight is a literal <mark …>…</mark> in the note's markdown, and in
// prose marked hands it through as an element. Inside a fence it does not:
// marked escapes the fence body, so the tag arrived as the TEXT "<mark>" —
// and even a real <mark> would not have survived, because Prism rebuilds a
// <code> from its textContent (once as the block is enhanced, and again when
// the autoloader has fetched the grammar), flattening every element in it.
//
// So the tags are lifted out here, before Prism sees the text, and put back
// after every pass Prism makes:
//
//   extractCodeMarks  reads the canonical marks out of the <code>'s text,
//                     leaves the clean code behind and remembers the ranges;
//   paintCodeMarks    wraps each range in ONE <mark> after highlighting.
//
// ── One source mark, one element ──────────────────────────────────────────
//
// Everything that addresses a highlight — the mark menu, the badges, the
// Highlights pane's jump, markSpanAt, setHighlightNoteAt — counts marks: the
// Nth <mark in the source is the Nth <mark> element in the view. So a range is
// never split into several marks where it crosses Prism's token spans; the
// TOKEN spans are split instead (shallow clones, same classes), and the mark
// holds whole tokens. A source mark in a fence therefore renders as exactly one
// element, and the ordinals stay honest — which they were not while the tag
// rendered as text: the source counted it and the DOM did not.
//
// ── Copy stays code ───────────────────────────────────────────────────────
//
// The marks and the note badge a mark can carry are furniture. What a reader
// copies out of a rendered code block is the code: codeCleanText is the text
// the block was written with, and the copy listener at the bottom puts exactly
// that slice on the clipboard. Where the code is being turned into something
// else in the app (a card, a pin, a Quick Note), codeTextWithMarks writes the
// highlights back out as source so they travel with it.

import { HIGHLIGHT_SCAN_RE, MARK_CLOSE_TAG, markOpenTag } from "../format/highlight.js?v=__BUILD__";

// Per <code> element: { text, ranges: [{ start, end, color, note }], marks: [] }
// — the clean code, the canonical marks it held, and the elements painted for
// them (reused on every repaint, so a mark keeps its identity and its badge).
// Elements with no marks are remembered as null so they are not re-parsed on
// every enhancement pass.
export const codeMarkModels = new WeakMap();

export function codeMarkModel(code) {
  return codeMarkModels.get(code) || null;
}

// The canonical marks in `text` (HIGHLIGHT_SCAN_RE's shape — the same one every
// source scanner counts), and the text with their tags removed. Shared with the
// write side (src/format/code-highlight.js), which has to see a fence body the
// way this sees the rendered block.
export function stripCodeMarks(text) {
  const source = String(text || "");
  const ranges = [];
  if (!source.includes("<mark")) return { text: source, ranges };
  const scan = new RegExp(HIGHLIGHT_SCAN_RE.source, "g");
  let clean = "";
  let cursor = 0;
  let m;
  while ((m = scan.exec(source))) {
    const inner = m[3];
    const openLength = m[0].length - inner.length - MARK_CLOSE_TAG.length;
    clean += source.slice(cursor, m.index);
    const start = clean.length;
    clean += inner;
    ranges.push({
      start,
      end: clean.length,
      color: m[1] || null,
      note: m[2] || null,
      rawStart: m.index,
      rawEnd: m.index + m[0].length,
      openLength
    });
    cursor = m.index + m[0].length;
  }
  clean += source.slice(cursor);
  return { text: clean, ranges };
}

// Reads the marks out of a freshly rendered <code> and leaves its clean text in
// place. Idempotent: a block patchRenderedBlocks reused already has a model (or
// a remembered null), and its text is no longer the source's.
export function extractCodeMarks(code) {
  if (!code || codeMarkModels.has(code)) return codeMarkModel(code);
  const raw = code.textContent || "";
  const { text, ranges } = stripCodeMarks(raw);
  if (!ranges.length) {
    codeMarkModels.set(code, null);
    return null;
  }
  const model = { text, ranges, marks: [], painted: false };
  codeMarkModels.set(code, model);
  code.textContent = text;
  return model;
}

function codeTextNodes(root) {
  const nodes = [];
  // The root's own document: Turndown hands over a block parsed into one of
  // its own.
  const walker = (root.ownerDocument || document).createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // A badge (or any button) inside a mark is not code.
    acceptNode: (node) => {
      const button = node.parentElement?.closest("button");
      return button && root.contains(button) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

// The top-level child of `code` that begins exactly at text offset `offset`,
// after splitting whatever straddles that point — the text node first, then
// each token span above it, up to `code`. null when `offset` is the end.
function splitCodeAt(code, offset) {
  let pos = 0;
  let target = null;
  let local = 0;
  for (const node of codeTextNodes(code)) {
    const length = node.data.length;
    if (offset < pos + length) {
      target = node;
      local = offset - pos;
      break;
    }
    pos += length;
  }
  if (!target) return null;
  let node = local > 0 ? target.splitText(local) : target;
  while (node.parentNode && node.parentNode !== code) {
    const parent = node.parentNode;
    if (node === parent.firstChild) {
      node = parent;
      continue;
    }
    const tail = parent.cloneNode(false);
    let move = node;
    while (move) {
      const next = move.nextSibling;
      tail.appendChild(move);
      move = next;
    }
    parent.after(tail);
    node = tail;
  }
  return node;
}

function markElementFor(model, index) {
  const range = model.ranges[index];
  let mark = model.marks[index];
  if (!mark) {
    mark = document.createElement("mark");
    if (range.color) mark.setAttribute("data-color", range.color);
    if (range.note) mark.setAttribute("data-note", range.note);
    model.marks[index] = mark;
  }
  return mark;
}

// Wraps every remembered range in its <mark>. Runs after each Prism pass (see
// the after-highlight hook) and, for a block Prism never touches, straight from
// enhanceCodeBlocks. A mark being reused keeps whatever buttons it carries (the
// note badge) — they are set aside, the mark refilled, and put back at its end.
export function paintCodeMarks(code) {
  const model = codeMarkModel(code);
  if (!model || model.painted) return;
  for (let i = model.ranges.length - 1; i >= 0; i -= 1) {
    const { start, end } = model.ranges[i];
    const mark = markElementFor(model, i);
    const keep = [...mark.children].filter((child) => child.nodeName === "BUTTON");
    mark.replaceChildren();
    const endNode = splitCodeAt(code, end);
    const startNode = splitCodeAt(code, start);
    if (!startNode) continue;
    code.insertBefore(mark, startNode);
    let node = startNode;
    while (node && node !== endNode) {
      const next = node.nextSibling;
      mark.appendChild(node);
      node = next;
    }
    keep.forEach((button) => mark.appendChild(button));
  }
  model.painted = true;
}

// Prism reads the code it highlights from textContent, which by the second pass
// (the autoloader's, once a grammar has arrived) includes every note badge's
// digit. The model's text is what the block actually says, so Prism is handed
// that — and whatever it builds, the marks are painted back over.
let codeMarkHooksInstalled = false;

export function installCodeMarkHooks() {
  if (codeMarkHooksInstalled || !window.Prism?.hooks) return;
  Prism.hooks.add("before-sanity-check", (env) => {
    const model = codeMarkModel(env.element);
    if (!model) return;
    env.code = model.text;
    model.painted = false;
  });
  Prism.hooks.add("after-highlight", (env) => {
    paintCodeMarks(env.element);
  });
  codeMarkHooksInstalled = true;
}

// What the block says, without its marks or their badges: the Copy button's
// answer, and the text the write side matches against the fence.
export function codeCleanText(code) {
  if (!code) return "";
  const model = codeMarkModel(code);
  if (model) return model.text;
  return codeTextNodes(code).map((node) => node.data).join("");
}

// The clean-text offset of a range boundary (`container`, `offset`) within
// `code`. A boundary before the block reads as 0, one after it as the length.
export function codeOffsetAt(code, container, offset) {
  const probe = document.createRange();
  probe.selectNodeContents(code);
  try {
    probe.setEnd(container, offset);
  } catch (_) {
    return null;
  }
  let count = 0;
  for (const node of codeTextNodes(code)) {
    if (node === container) return count + Math.min(offset, node.data.length);
    if (probe.comparePoint(node, node.data.length) <= 0) count += node.data.length;
    else break;
  }
  return count;
}

// The [start, end) a Range covers in `code`'s clean text.
export function codeRangeOffsets(code, range) {
  const start = codeOffsetAt(code, range.startContainer, range.startOffset);
  const end = codeOffsetAt(code, range.endContainer, range.endOffset);
  if (start == null || end == null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

// The block's code with its highlights written back as source — `<mark …>`
// around every stretch that sits inside a <mark> element, clipped to `range`
// when one is given (a highlight half inside the selection keeps the half that
// is). A pure walk of the DOM, so it works on the detached, partial clone of a
// block Turndown is handed as well as on the live one.
export function codeTextWithMarks(code, range = null) {
  if (!code) return "";
  const bounds = range ? codeRangeOffsets(code, range) : null;
  const from = bounds ? bounds.start : 0;
  const to = bounds ? bounds.end : Infinity;
  let out = "";
  let pos = 0;
  let open = null;
  for (const node of codeTextNodes(code)) {
    const length = node.data.length;
    const lo = Math.max(from, pos);
    const hi = Math.min(to, pos + length);
    if (hi > lo) {
      const mark = node.parentElement?.closest("mark");
      const owned = mark && code.contains(mark) ? mark : null;
      if (owned !== open) {
        if (open) out += MARK_CLOSE_TAG;
        if (owned) out += markOpenTag(owned.getAttribute("data-color"), owned.getAttribute("data-note"));
        open = owned;
      }
      out += node.data.slice(lo - pos, hi - pos);
    }
    pos += length;
    if (pos >= to) break;
  }
  if (open) out += MARK_CLOSE_TAG;
  return out;
}

// The <code> of the rendered block a range boundary sits in, or null. Same
// reasoning as boundaryCodeBlock in src/notes/selection.js: a triple-click or a
// drag past the last line parks a boundary ON the <pre> rather than in the code.
function boundaryCode(container, offset) {
  const start = container.nodeType === Node.TEXT_NODE
    ? container.parentElement
    : (container.childNodes[Math.min(offset, container.childNodes.length - 1)] || container);
  const node = start?.nodeType === Node.TEXT_NODE ? start.parentElement : start;
  const pre = node?.closest?.("pre") || (container.nodeType === Node.ELEMENT_NODE ? container.closest?.("pre") : null);
  return pre?.querySelector("code") || null;
}

// The <code> a whole range lies in, or null when it starts and ends in
// different places (or outside code altogether).
export function rangeCodeBlock(range) {
  if (!range) return null;
  const start = boundaryCode(range.startContainer, range.startOffset);
  if (!start) return null;
  const end = boundaryCode(range.endContainer, range.endOffset);
  return end === start ? start : null;
}

// Ctrl+C / the context menu's Copy over a highlighted code block: the code, and
// only the code. Without this the browser serialises the selection itself —
// which carries a note badge's digit ("return 1x") and, as HTML, the marks into
// whatever the code is pasted into. A block with no highlights in it is left to
// the browser exactly as before.
function onCodeCopy(event) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !event.clipboardData) return;
  const range = selection.getRangeAt(0);
  const code = rangeCodeBlock(range);
  if (!code || !codeMarkModel(code) || !code.closest(".rendered")) return;
  const offsets = codeRangeOffsets(code, range);
  if (!offsets || offsets.end <= offsets.start) return;
  event.clipboardData.setData("text/plain", codeCleanText(code).slice(offsets.start, offsets.end));
  event.preventDefault();
}

let codeCopyInstalled = false;

export function installCodeCopyCleaner() {
  if (codeCopyInstalled) return;
  document.addEventListener("copy", onCodeCopy);
  codeCopyInstalled = true;
}
