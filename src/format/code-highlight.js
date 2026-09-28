// Making, recolouring and removing a highlight INSIDE a code block — the write
// side of src/render/code-marks.js.
//
// A highlight in prose is found in the source by its words (locate-selection.js)
// and wrapped by wrapAcrossBlocks, which keeps every list marker, quote and
// heading prefix outside the mark. Both are wrong for code:
//
//   • Code repeats itself. `}`, `return x;`, `i += 1` are on every other line,
//     and a text search picks a copy by counting — the wrong one, often enough
//     to matter.
//   • A code line that starts with `# `, `- `, `> ` or `| ` is a comment, a YAML
//     item, a prompt, a pipe — not a heading, list, quote or table. Splitting it
//     around that "prefix" cut the line in two.
//
// So a selection made inside one rendered code block is addressed by POSITION:
// renderedSelectionStrings hands over the block's clean text and the [start,
// end) the selection covers in it; the block is matched to its fence by that
// whole text (which is as unique as code gets), the offsets are mapped through
// the fence's own marks and indentation to raw offsets, and ONE <mark> goes in.
//
// Also here: what the rest of the app needs to know about a mark that sits in
// a fence — which fence (codeFenceAt), and the fenced snippet a card, pin or
// Highlights-pane row should show for it (codeHighlightSnippet), with the
// highlights still in it.

import { MARK_HIGHLIGHT_DEFAULT } from "./highlight-colors.js?v=__BUILD__";
import { MARK_CLOSE_TAG, markOpenTag } from "./highlight.js?v=__BUILD__";
import { readerNotesBody } from "./notes-fence.js?v=__BUILD__";
import { approximateRawOffsetForBlock } from "../notes/raw-offset.js?v=__BUILD__";
import { codeCleanText, stripCodeMarks } from "../render/code-marks.js?v=__BUILD__";
import { scanFences } from "../render/preprocess.js?v=__BUILD__";

// The same test preprocessSpecialBlocks uses to lift a fence out as a diagram:
// those never render as a code block, so they are never a candidate.
export function isDiagramFence(fence) {
  return /\bmermaid\b/i.test(fence.info) || /\bnomnoml\b/i.test(fence.info);
}

// The fences a selection or a mark can be inside: every fenced block in the
// note that renders as code.
export function codeFences(source) {
  return scanFences(source).filter((fence) => !isDiagramFence(fence));
}

// The fence whose BODY holds [start, end), or null. `end` defaults to `start`,
// for "is this offset in code".
export function codeFenceAt(fences, start, end = start) {
  let lo = 0;
  let hi = fences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const fence = fences[mid];
    if (start < fence.bodyStart) hi = mid - 1;
    else if (start >= fence.bodyEnd) lo = mid + 1;
    else return end <= fence.bodyEnd ? fence : null;
  }
  return null;
}

// A fence body as the rendered block sees it, and the way back.
//
// The rendered <code> holds the fence body with (a) the opener's indentation
// removed from each line — CommonMark strips up to that many spaces, and marked
// follows it — and (b) its marks lifted out by extractCodeMarks. `text` is that
// string; `ranges` are the marks in it; rawStartAt / rawEndAt turn a clean
// offset back into a source offset:
//
//   rawStartAt(i)  where character i begins — AFTER any tags in front of it, so a
//                  new mark opened here sits outside a neighbour that ends here;
//   rawEndAt(i)    just past character i-1 — BEFORE any tags after it, for the
//                  same reason at the other end.
export function fenceCodeModel(source, fence) {
  const indent = fence.indent.length;
  let dedented = "";
  const at = [];
  let pos = fence.bodyStart;
  source.slice(fence.bodyStart, fence.bodyEnd).split(/(?<=\n)/).forEach((line) => {
    let skip = 0;
    while (skip < indent && (line[skip] === " " || line[skip] === "\t")) skip += 1;
    for (let k = skip; k < line.length; k += 1) {
      dedented += line[k];
      at.push(pos + k);
    }
    pos += line.length;
  });
  at.push(fence.bodyEnd);
  // normalizeMarkdown turns a no-break space into a plain one before marked
  // sees it; same length, so the offsets are unaffected.
  const { text, ranges } = stripCodeMarks(dedented.replace(/ /g, " "));
  // clean index -> dedented index, skipping every tag.
  const cleanAt = [];
  let ded = 0;
  ranges.forEach((range) => {
    while (ded < range.rawStart) cleanAt.push(ded++);
    ded = range.rawStart + range.openLength;
    for (let k = range.start; k < range.end; k += 1) cleanAt.push(ded++);
    ded += MARK_CLOSE_TAG.length;
  });
  while (ded < dedented.length) cleanAt.push(ded++);
  const rawStartAt = (i) => (i < cleanAt.length ? at[cleanAt[i]] : fence.bodyEnd);
  const rawEndAt = (i) => (i <= 0 ? rawStartAt(0) : at[cleanAt[i - 1]] + 1);
  return {
    fence,
    text,
    ranges: ranges.map((range) => ({
      ...range,
      // The mark's own tags, in source coordinates.
      sourceStart: at[range.rawStart],
      sourceEnd: at[range.rawEnd - 1] + 1
    })),
    rawStartAt,
    rawEndAt
  };
}

const trimCode = (text) => String(text || "").replace(/ /g, " ").replace(/\n+$/, "");

// The fence a rendered code block came from. Matched by the block's whole
// clean text; when several fences say exactly the same thing, by the block's
// position among the same-text blocks in the view (every one of them is in the
// document on an eagerly rendered note), else by which one sits nearest where
// the block's own text puts it (a note built as it is read).
export function locateCodeFence(source, codeText, { view = null, element = null } = {}) {
  const want = trimCode(codeText);
  if (!want) return null;
  const matches = [];
  codeFences(readerNotesBody(source)).forEach((fence) => {
    if (fence.bodyEnd - fence.bodyStart < want.length) return;
    const model = fenceCodeModel(source, fence);
    if (trimCode(model.text) === want) matches.push(model);
  });
  if (matches.length <= 1 || !view || !element) return matches[0] || null;
  const twins = [...view.querySelectorAll("pre code")].filter((code) => trimCode(codeCleanText(code)) === want);
  const ordinal = twins.indexOf(element);
  if (ordinal !== -1 && twins.length === matches.length) return matches[ordinal];
  let hint = null;
  try {
    hint = approximateRawOffsetForBlock(view, source, element.closest("pre") || element);
  } catch (_) {
    hint = null;
  }
  if (!Number.isFinite(hint)) return null;
  return matches.reduce((best, model) =>
    (Math.abs(model.fence.start - hint) < Math.abs(best.fence.start - hint) ? model : best));
}

// The highlight verb for a selection inside one code block — the counterpart of
// highlightToggleInSource, returning the same { text, action, idx } shape (idx is
// the new or edited mark's own `<mark` offset, which is what "Highlight and
// annotate" turns into an ordinal).
//
//   • exactly an existing mark — or, on a touch screen where the DOM overlap
//     test cannot run, overlapping exactly one — recolours it, or removes it
//     when it is already that colour or `color` is "clear";
//   • overlapping more than one is refused ("already");
//   • anything else is wrapped in one new mark.
//
// null when the block cannot be matched to a fence; the caller falls back to
// the text search.
export function highlightCodeSelectionInSource(source, sel, color) {
  const selected = sel?.code;
  if (!selected) return null;
  const model = locateCodeFence(source, selected.text, { view: sel.view, element: selected.element });
  if (!model) return null;
  let start = Math.min(selected.start, model.text.length);
  let end = Math.min(selected.end, model.text.length);
  // A drag that begins at the end of the line above, or ends on the block's
  // last newline, carries a line break at its edge that is nobody's highlight.
  while (end > start && model.text[end - 1] === "\n") end -= 1;
  while (start < end && model.text[start] === "\n") start += 1;
  if (!model.text.slice(start, end).trim()) return null;

  const touching = model.ranges.filter((range) => range.start < end && start < range.end);
  if (touching.length > 1) return { text: source, action: "already", idx: model.rawStartAt(start) };
  if (touching.length === 1) {
    // A live selection that overlaps one mark was already handled by the DOM
    // overlap path before this ran, so here "overlaps one" means a touch
    // screen's captured selection, or a selection that is exactly the mark:
    // either way it is that mark, as the overlap path would have treated it.
    const range = touching[0];
    const inner = source.slice(range.sourceStart + range.openLength, range.sourceEnd - MARK_CLOSE_TAG.length);
    const existing = range.color || MARK_HIGHLIGHT_DEFAULT;
    if (color === "clear" || color === existing) {
      return {
        text: source.slice(0, range.sourceStart) + inner + source.slice(range.sourceEnd),
        action: "removed",
        idx: range.sourceStart
      };
    }
    return {
      // Keeps the mark's note: recolouring an annotated highlight must not drop it.
      text: source.slice(0, range.sourceStart) + markOpenTag(color, range.note) + inner + MARK_CLOSE_TAG + source.slice(range.sourceEnd),
      action: "recolored",
      idx: range.sourceStart
    };
  }
  const rawStart = model.rawStartAt(start);
  if (color === "clear") return { text: source, action: "not-highlighted", idx: rawStart };
  const rawEnd = model.rawEndAt(end);
  return {
    text: source.slice(0, rawStart) + markOpenTag(color) + source.slice(rawStart, rawEnd) + MARK_CLOSE_TAG + source.slice(rawEnd),
    action: "added",
    idx: rawStart
  };
}

// The info string's first word — what marked puts on the block as its class,
// and what a fence rebuilt from this one should declare.
export function fenceLanguage(fence) {
  return (String(fence?.info || "").match(/^\S*/) || [""])[0];
}

// A fence long enough to hold `text`: one backtick more than the longest run in
// it, and never fewer than three.
export function fenceFor(text) {
  const runs = String(text || "").match(/`+/g) || [];
  const longest = runs.reduce((n, run) => Math.max(n, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

// Up to `indent` columns of leading whitespace off each line — what CommonMark
// takes off a fence's body lines when the opener is indented. `fromFirst` is
// false for a slice that starts mid-line, whose first line has no indentation of
// its own to lose.
function dedentCode(text, indent, fromFirst = true) {
  if (!indent) return text;
  return text.split("\n").map((line, i) => {
    if (i === 0 && !fromFirst) return line;
    let skip = 0;
    while (skip < indent && (line[skip] === " " || line[skip] === "\t")) skip += 1;
    return line.slice(skip);
  }).join("\n");
}

// A card, a pin, a Highlights-pane row: what a mark in code should be shown as
// once it leaves its block. The whole LINES the source span [start, end) sits
// on, dedented the way the block renders them, with every highlight on those
// lines still in them — fenced with the block's language, so it renders as the
// same highlighted code rather than as a line of prose (`__init__` turning bold,
// `a * b` italic). `text` is the span's own code with no marks at all, for
// Copy. null when the span is not inside one code fence.
export function codeHighlightSnippet(source, fences, start, end) {
  const fence = codeFenceAt(fences, start, end);
  if (!fence) return null;
  const indent = fence.indent.length;
  const lineStart = Math.max(source.lastIndexOf("\n", start - 1) + 1, fence.bodyStart);
  const newline = source.indexOf("\n", Math.max(start, end - 1));
  const lineEnd = Math.min(newline === -1 ? source.length : newline, fence.bodyEnd);
  const lines = dedentCode(source.slice(lineStart, lineEnd), indent).replace(/\n+$/, "");
  const language = fenceLanguage(fence);
  const fenceMark = fenceFor(lines);
  return {
    fence,
    language,
    markdown: `${fenceMark}${language}\n${lines}\n${fenceMark}`,
    text: stripCodeMarks(dedentCode(source.slice(start, end), indent, start === lineStart)).text
  };
}
