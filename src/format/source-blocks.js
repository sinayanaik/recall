// Where a rendered selection begins and ends in the markdown, found block by
// block instead of by searching the note for the selected words.
//
// locateSelectionInSource's text search needs the WHOLE selection to read back
// the same way in the source, and a long selection rarely does: one formula, one
// `&amp;`, one image whose src was rewritten for display, one escaped `\*`
// anywhere in the middle and nothing matches — "Couldn't match that selection".
// Nothing in the middle of a selection says where it is, though. Only its two
// ends do. So each end is placed on its own, inside the one block it sits in:
//
//   rendered node → its top-level block in the render cache
//                 → that block's slice of the PREPARED text (exact: the cache
//                   keeps every block's prepared source and its offset)
//                 → the same slice of the note's own markdown (a line alignment
//                   of the prepared text against the source, see
//                   preparedSourceMap — preprocessSpecialBlocks rewrites inside
//                   lines but leaves almost every line byte for byte alone)
//                 → the character inside that slice (an alignment of the
//                   block's rendered text against its markdown, both with the
//                   markup projected away — see placeInBlock)
//
// Whatever lies between the two ends is never compared with anything, so a
// table, a picture or a page of maths in the middle of a selection costs
// nothing and cannot make it fail. Anything this cannot place exactly answers
// null, and the caller falls back to the text search it always had.

import { el } from "../core/dom.js?v=__BUILD__";
import { normalizeMarkdown } from "../import/parse-cards.js?v=__BUILD__";
import { readerNotesBody } from "./notes-fence.js?v=__BUILD__";
import { atomicSourceForNode, snapRangeToAtomicBlocks } from "../notes/selection.js?v=__BUILD__";
// locate-selection.js imports this module for its first stage, so this closes a
// cycle. Everything used from it is called at runtime, never while either
// module body is still evaluating.
import { NORMALIZE_DROP_CHARS, inlineRegionsNear, normalizeMarkupForMatch } from "./locate-selection.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR, rawOffsetForRenderedBlock } from "../notes/raw-offset.js?v=__BUILD__";
import {
  blockStartOffsets,
  isTopLevelBlockParent,
  notesLazySpanStarts,
  promotedNotesHeadings,
  renderGeneration,
  renderedBlockCache
} from "../render/block-cache.js?v=__BUILD__";

// ── The surface and the markdown it was rendered from ──────────────────────

// The notes view renders readerNotesBody(source) with its headings promoted (see
// renderMarkdown); a card face renders its own text. The cache entry must have
// been built from exactly that, or nothing it knows applies to this source.
export function renderedSourceContext(view, source) {
  if (!view) return null;
  const cached = renderedBlockCache.get(view);
  if (!cached || cached.generation !== renderGeneration || typeof cached.prepared !== "string") return null;
  const text = String(source ?? "");
  const body = view === el.notesView ? readerNotesBody(text) : text;
  const display = view === el.notesView ? promotedNotesHeadings(body) : body;
  if (display !== cached.source) return null;
  return { view, cached, source: text, body, display };
}

// ── Prepared text → markdown offsets ───────────────────────────────────────

// Offsets of every line start in `lines` (split on "\n").
export function lineStartOffsets(lines) {
  const starts = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i += 1) {
    starts[i] = at;
    at += lines[i].length + 1;
  }
  return starts;
}

// The last index whose value is <= `at` in a sorted array.
export function lastIndexAtOrBefore(sorted, at) {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= at) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// How far either side a run of rewritten lines may reach before the alignment
// gives up looking for the next pair of identical lines. A diagram fence is the
// longest thing preprocessSpecialBlocks collapses (into one line), so this is a
// bound on the length of a mermaid source, not on anything common.
export const LINE_RESYNC_MAX = 4000;

// A line's words, with everything preprocessSpecialBlocks rewrites inside a
// line reduced to what survives the rewrite: a formula (either form) is one
// token, other tags are dropped (a cloze becomes a <span> around the same
// words), and so is every character that is not a letter or a digit — except
// the line's own block marker, so that "- $x$" and its rewrite still have
// something to agree on. A line and its prepared rewrite have the same
// skeleton; two different lines almost never do.
export function lineSkeleton(line) {
  // Only the marker's kind: the notes view promotes "###" to "##", and a list
  // may be renumbered, without the line being any less the same line.
  const marker = /^[ \t]*(?:([-*+])|(\d{1,9})[.)]|(>)|(#){1,6}|(\|))(?=[ \t])/.exec(line);
  const kind = marker ? (marker[1] ? "-" : marker[2] ? "1" : marker[3] || marker[4] || marker[5]) : "";
  const body = line
    .replace(/<(span|div) class="math-(?:inline|display)"[^>]*><\/\1>/g, "\u00a7")
    .replace(/\$\$?[^$\n]+?\$\$?/g, "\u00a7")
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\u00a7]+/gu, "");
  return body ? kind + body : "";
}

// Pair the lines of `a` with the lines of `b`, where one is the other with some
// lines rewritten (and a few runs of lines collapsed into one). Returns segments
// { a0, a1, b0, b1, same } covering both line lists in order; a `same` segment
// pairs its lines one to one. Two lines correspond when they are identical or a
// rewrite of each other (same skeleton). At a run that does not correspond, the
// nearest pair that does — fewest lines skipped on both sides together —
// resumes the match. A blank line is only trusted as that pair when the line
// after it corresponds too: blank lines are everywhere, and a diagram fence's
// own blank line would otherwise "resync" in the middle of the diagram it was
// collapsed into.
export function alignLineLists(a, b) {
  const skeletonsA = new Array(a.length);
  const skeletonsB = new Array(b.length);
  const skeletonOf = (lines, memo, k) => (memo[k] === undefined ? (memo[k] = lineSkeleton(lines[k])) : memo[k]);
  const correspond = (x, y) => {
    if (a[x] === b[y]) return true;
    const skeleton = skeletonOf(a, skeletonsA, x);
    return Boolean(skeleton) && skeleton === skeletonOf(b, skeletonsB, y);
  };
  const segments = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    // A formula or diagram the prepared side (`a`) collapsed into one line — with
    // the blank lines protectMath puts around it — pairs with exactly the lines
    // it came from, by its own decoded source. Left to the generic resync, two
    // of them in a row run together into one unmatched stretch, and every block
    // boundary inside it is lost.
    const collapsed = i < a.length && j < b.length && !correspond(i, j) ? collapsedRunAt(a, i, b, j) : null;
    if (collapsed) {
      if (collapsed.atomic > i) segments.push({ a0: i, a1: collapsed.atomic, b0: j, b1: j, same: false });
      segments.push({ a0: collapsed.atomic, a1: collapsed.atomic + 1, b0: j, b1: collapsed.end, same: false });
      i = collapsed.atomic + 1;
      j = collapsed.end;
      continue;
    }
    if (i < a.length && j < b.length && correspond(i, j)) {
      const i0 = i;
      const j0 = j;
      while (i < a.length && j < b.length && correspond(i, j)) {
        i += 1;
        j += 1;
      }
      segments.push({ a0: i0, a1: i, b0: j0, b1: j, same: true });
      continue;
    }
    let next = null;
    const reach = Math.min(LINE_RESYNC_MAX, (a.length - i) + (b.length - j));
    for (let d = 1; d <= reach && !next; d += 1) {
      for (let di = 0; di <= d; di += 1) {
        const ai = i + di;
        const bj = j + (d - di);
        if (ai >= a.length || bj >= b.length) continue;
        if (!correspond(ai, bj)) continue;
        if (!a[ai].trim() && !(ai + 1 >= a.length || (bj + 1 < b.length && correspond(ai + 1, bj + 1)))) continue;
        next = { i: ai, j: bj };
        break;
      }
    }
    const ni = next ? next.i : a.length;
    const nj = next ? next.j : b.length;
    // Lines at the far end of the run that do correspond (a blank line, the
    // line after a collapsed formula) are paired back off it, so that only what
    // was really rewritten is left without a line-by-line match.
    let ei = ni;
    let ej = nj;
    while (ei > i && ej > j && correspond(ei - 1, ej - 1)) {
      ei -= 1;
      ej -= 1;
    }
    segments.push({ a0: i, a1: ei, b0: j, b1: ej, same: false });
    if (ei < ni) segments.push({ a0: ei, a1: ni, b0: ej, b1: nj, same: true });
    i = ni;
    j = nj;
  }
  return segments;
}

// The source a collapsed formula or diagram line carries, decoded, or null.
export const COLLAPSED_ATOMIC_LINE_RE = /^<div class="(math-display|mermaid|nomnoml-diagram)\b[^"]*"[^>]*\bdata-(?:tex|diagram)="([^"]*)"[^>]*><\/div>$/;

export function collapsedAtomicSource(line) {
  const m = COLLAPSED_ATOMIC_LINE_RE.exec(line.trim());
  if (!m) return null;
  try {
    return { kind: m[1], source: decodeURIComponent(m[2].replace(/&amp;/g, "&")) };
  } catch (_) {
    return null;
  }
}

// Letters and digits only: the decoded source has been healed of escapes and
// trimmed, so this is the comparison that survives both.
export function alnumOf(text) {
  return String(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

// A collapsed formula or diagram at a[i] (after any blank lines protectMath
// inserted before it), matched to the lines starting at b[j]: { atomic, end }
// where a[atomic] is the collapsed line and b[j..end) the lines it came from.
export function collapsedRunAt(a, i, b, j) {
  let k = i;
  while (k < a.length && !a[k].trim()) k += 1;
  if (k >= a.length || k - i > 2) return null;
  const atomic = collapsedAtomicSource(a[k]);
  if (!atomic) return null;
  const first = b[j].trim();
  let end = -1;
  let body = "";
  if (atomic.kind === "math-display") {
    if (first.startsWith("$$") && first.length > 4 && first.endsWith("$$")) {
      end = j + 1;
      body = first;
    } else if (first === "$$" || first === "$" || first.startsWith("$$")) {
      const closer = first === "$" ? "$" : "$$";
      for (let n = j + 1; n < b.length && n - j < LINE_RESYNC_MAX; n += 1) {
        if (closer === "$" ? b[n].trim() === "$" : b[n].includes("$$")) {
          end = n + 1;
          break;
        }
      }
      if (end !== -1) body = b.slice(j, end).join("\n");
    }
  } else if (/^(```|~~~)/.test(first)) {
    const fence = first.slice(0, 3);
    for (let n = j + 1; n < b.length && n - j < LINE_RESYNC_MAX; n += 1) {
      if (b[n].trim().startsWith(fence)) {
        end = n + 1;
        break;
      }
    }
    if (end !== -1) body = b.slice(j + 1, end - 1).join("\n");
  }
  if (end === -1 || alnumOf(body) !== alnumOf(atomic.source)) return null;
  return { atomic: k, end };
}

// A column in line `from` → the same place in line `to`, where the two lines
// differ only somewhere in the middle (a promoted heading's extra "#", a
// formula rewritten into a tag). Whatever the lines share at their end is
// aligned from the end; everything before it is clamped to the shared start.
export function mapColumnBetweenLines(from, to, col) {
  if (from === to) return col;
  let prefix = 0;
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < from.length - prefix && suffix < to.length - prefix
    && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) suffix += 1;
  if (col <= prefix) return col;
  if (col >= from.length - suffix) return to.length - (from.length - col);
  return Math.min(to.length - suffix, prefix);
}

// Offsets in one text → the other, through a line alignment. `edge` decides
// where an offset inside a run of rewritten lines of a different length lands:
// at the start of the run or at its end.
export function lineOffsetMapper(fromText, toText) {
  if (fromText === toText) return (offset) => offset;
  const from = fromText.split("\n");
  const to = toText.split("\n");
  const fromStarts = lineStartOffsets(from);
  const toStarts = lineStartOffsets(to);
  // `from` is the side collapsedRunAt looks for collapsed lines on: the prepared
  // text, when preparedSourceMap builds this.
  const segments = alignLineLists(from, to);
  const segmentStarts = segments.map((segment) => segment.a0);
  return (offset, edge = "start") => {
    const at = Math.max(0, Math.min(fromText.length, offset));
    const line = lastIndexAtOrBefore(fromStarts, at);
    const col = at - fromStarts[line];
    let index = lastIndexAtOrBefore(segmentStarts, line);
    // Empty segments (nothing on the `from` side) share a start with the next.
    while (index + 1 < segments.length && segments[index + 1].a0 === line && segments[index + 1].a1 > line) index += 1;
    const segment = segments[index];
    if (!segment || line >= segment.a1) return toText.length;
    if (segment.same || segment.a1 - segment.a0 === segment.b1 - segment.b0) {
      const target = segment.b0 + (line - segment.a0);
      if (target >= to.length) return toText.length;
      return toStarts[target] + Math.min(to[target].length, mapColumnBetweenLines(from[line], to[target], col));
    }
    // A run collapsed or expanded: only its two ends correspond. The very start
    // of it is the boundary with whatever came before, whichever way the caller
    // leans; anything past that is inside the run, and lands at whichever end
    // `edge` asks for.
    const runStart = segment.b0 < to.length ? toStarts[segment.b0] : toText.length;
    if (line === segment.a0 && col === 0) return runStart;
    if (edge !== "end") return runStart;
    const last = segment.b1 - 1;
    if (last < segment.b0) return runStart;
    return toStarts[last] + to[last].length;
  };
}

// normalizeMarkdown folds "\r\n" into "\n" (one character fewer each); undo that.
export function crlfOffsetMapper(original, normalized) {
  if (original.length === normalized.length) return (offset) => offset;
  const removed = [];
  for (let i = original.indexOf("\r\n"); i !== -1; i = original.indexOf("\r\n", i + 2)) {
    removed.push(i - removed.length);
  }
  return (offset) => {
    let lo = 0;
    let hi = removed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (removed[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return offset + lo;
  };
}

// One per cache entry: an entry is a fresh object per render, so there is
// nothing to invalidate, and the next edit simply builds the next one.
export const preparedSourceMaps = new WeakMap();

// prepared offset → offset in the note's markdown.
export function preparedSourceMap(context) {
  const { cached, body, display } = context;
  const memo = preparedSourceMaps.get(cached);
  if (memo && memo.body === body) return memo.toSource;
  const normalized = normalizeMarkdown(display);
  const preparedToNormalized = lineOffsetMapper(cached.prepared, normalized);
  const normalizedToDisplay = crlfOffsetMapper(display, normalized);
  const displayToBody = lineOffsetMapper(display, body);
  const toSource = (offset, edge = "start") => displayToBody(normalizedToDisplay(preparedToNormalized(offset, edge)), edge);
  preparedSourceMaps.set(cached, { body, toSource });
  return toSource;
}

// ── Rendered node → its block in the render cache ──────────────────────────

export const preparedBlockStarts = new WeakMap();

export function eagerBlockStarts(cached) {
  if (preparedBlockStarts.has(cached)) return preparedBlockStarts.get(cached);
  const starts = Array.isArray(cached.blocks)
    ? blockStartOffsets(cached.prepared, cached.blocks.map((entry) => entry.key || ""))
    : null;
  preparedBlockStarts.set(cached, starts);
  return starts;
}

// The top-level DOM nodes standing for a block's node group, in order. A block
// is often wrapped after it is built (a table in its scroller, a picture in its
// shell), so the node the cache remembers may now sit inside the one that is
// really at the top.
export function topLevelNodesFor(view, nodes) {
  const tops = [];
  for (const node of nodes || []) {
    let top = node;
    while (top && top.parentNode && !isTopLevelBlockParent(top.parentNode, view)) top = top.parentNode;
    if (top && isTopLevelBlockParent(top.parentNode, view) && !tops.includes(top)) tops.push(top);
  }
  return tops;
}

export function groupOwns(group, top) {
  return Array.isArray(group) && group.some((node) => node && (node === top || top.contains(node)));
}

// A range boundary set on the surface (or one of its chunks) points between two
// children; turn it into a boundary at the edge of the child it means.
export function descendToContent(view, node, offset, edge) {
  let target = node;
  let at = offset;
  for (let guard = 0; guard < 4 && target && target.nodeType === 1 && (target === view || isTopLevelBlockParent(target, view)); guard += 1) {
    const kids = target.childNodes;
    if (!kids.length) return null;
    if (edge === "start") {
      target = kids[Math.min(at, kids.length - 1)];
      at = 0;
    } else {
      target = kids[Math.max(0, Math.min(at, kids.length) - 1)];
      at = target.nodeType === 3 ? target.data.length : target.childNodes.length;
    }
  }
  return target ? { node: target, offset: at } : null;
}

// { preparedStart, preparedEnd, key, roots } for the top-level block holding
// `node`, or null when the cache cannot say exactly which block that is.
export function renderedBlockFor(context, node) {
  const { view, cached } = context;
  let top = node && node.nodeType === 1 ? node : node?.parentNode;
  while (top && top.parentNode && !isTopLevelBlockParent(top.parentNode, view)) top = top.parentNode;
  if (!top || !isTopLevelBlockParent(top.parentNode, view)) return null;

  const plan = cached.lazy;
  if (plan) {
    const index = plan.chunks.indexOf(top.parentNode);
    if (index === -1) return null;
    const groups = plan.groups[index];
    const raws = plan.blocks[index];
    if (!groups || !raws) return null;
    const n = groups.findIndex((group) => groupOwns(group, top));
    if (n === -1 || n >= raws.length) return null;
    const starts = notesLazySpanStarts(plan, index);
    if (!starts || n >= starts.length) return null;
    const preparedStart = plan.spans[index].start + starts[n];
    return { preparedStart, preparedEnd: preparedStart + raws[n].length, key: raws[n], roots: topLevelNodesFor(view, groups[n]) };
  }

  if (!Array.isArray(cached.blocks)) return null;
  const n = cached.blocks.findIndex((entry) => groupOwns(entry.nodes, top));
  if (n === -1) return null;
  const starts = eagerBlockStarts(cached);
  if (!starts || n >= starts.length) return null;
  const key = cached.blocks[n].key || "";
  return { preparedStart: starts[n], preparedEnd: starts[n] + key.length, key, roots: topLevelNodesFor(view, cached.blocks[n].nodes) };
}

// ── A block's rendered text, and where a point sits in it ──────────────────

// Interface the renderer adds that has no markdown behind it.
export const RENDERED_CHROME_SELECTOR = [
  "button", "style", "script", "input", "select", "textarea", ".katex-mathml", ".hl-note-badge", ".code-copy-btn",
  ".notes-fold-twisty", ".heading-number-mark", ".heading-number"
].join(", ");

export const RENDERED_BLOCK_TAGS = new Set([
  "P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE", "THEAD", "TBODY",
  "TFOOT", "TR", "TD", "TH", "DL", "DT", "DD", "HR", "FIGURE", "FIGCAPTION", "SECTION", "DETAILS", "SUMMARY"
]);

// Emits the text a reader sees for the markdown behind it: words as they are,
// a formula or diagram as its own source (see atomicSourceForNode), a picture
// as "!" and its alt text (which is what "![alt](…)" projects to), and a space
// wherever a block or line break separates two runs. `stop`, when given, is a
// { node, offset, edge } boundary: its position is recorded in out.at.
export function emitRenderedBlockText(node, out, stop) {
  const reach = () => { out.at = out.text.length; };
  if (node.nodeType === 3) {
    if (stop && node === stop.node) {
      out.text += node.data.slice(0, stop.offset);
      reach();
      out.text += node.data.slice(stop.offset);
      return;
    }
    out.text += node.data;
    return;
  }
  if (node.nodeType !== 1) return;
  const holdsStop = Boolean(stop) && (node === stop.node || node.contains(stop.node));
  if (node.matches(RENDERED_CHROME_SELECTOR) || (node.getAttribute("aria-hidden") === "true" && !atomicSourceForNode(node))) {
    if (holdsStop) reach();
    return;
  }
  const atomic = atomicSourceForNode(node);
  if (atomic) {
    if (holdsStop && stop.edge !== "end") reach();
    out.text += ` ${atomic} `;
    if (holdsStop && stop.edge === "end") reach();
    return;
  }
  if (node.tagName === "IMG") {
    if (holdsStop && stop.edge !== "end") reach();
    out.text += ` !${node.getAttribute("alt") || ""} `;
    if (holdsStop && stop.edge === "end") reach();
    return;
  }
  if (node.tagName === "BR") {
    out.text += "\n";
    if (holdsStop) reach();
    return;
  }
  const block = RENDERED_BLOCK_TAGS.has(node.tagName);
  if (block) out.text += "\n";
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i += 1) {
    if (stop && node === stop.node && i === stop.offset) reach();
    emitRenderedBlockText(kids[i], out, holdsStop && node !== stop.node ? stop : null);
  }
  if (stop && node === stop.node && stop.offset >= kids.length) reach();
  if (block) out.text += "\n";
}

export function renderedBlockText(roots, stop = null) {
  const out = { text: "", at: -1 };
  for (const root of roots) emitRenderedBlockText(root, out, stop && (root === stop.node || root.contains(stop.node)) ? stop : null);
  return out;
}

// The rendered-text twin of normalizeMarkupForMatch: whitespace collapsed to
// single spaces and the same syntax characters dropped, so a block's rendered
// text and its markdown project onto the same string wherever they agree.
// There is no markup to strip here — the rendered text has none.
export function projectRenderedText(str) {
  const chars = [];
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === " ") {
      pendingSpace = true;
      continue;
    }
    if (NORMALIZE_DROP_CHARS.has(ch)) continue;
    if (pendingSpace && chars.length) {
      chars.push(" ");
      map.push(i);
    }
    pendingSpace = false;
    chars.push(ch);
    map.push(i);
  }
  return { text: chars.join(""), map };
}

// How far a character alignment may skip, on both sides together, to get back in
// step after a difference — an image tag's URL, a link's target, an entity, a
// heading number. Far longer than any of those, far shorter than a block.
export const CHAR_RESYNC_MAX = 600;

// The run of agreeing characters that counts as being back in step.
export const CHAR_RESYNC_RUN = 4;

// One entity → the character it renders as, through the browser's own parser
// (a <textarea> decodes and never runs anything), remembered.
export const decodedEntities = new Map();

export function decodeEntity(entity) {
  if (decodedEntities.has(entity)) return decodedEntities.get(entity);
  let decoded = entity;
  try {
    const box = document.createElement("textarea");
    box.innerHTML = entity;
    decoded = box.value;
  } catch (_) { /* no DOM: leave it as written */ }
  decodedEntities.set(entity, decoded);
  return decoded;
}

// A block's markdown projected the way projectRenderedText projects what it
// renders, so the two line up wherever they say the same thing.
export function projectSourceText(raw) {
  return withoutDroppedCharacters(projectDecodedSource(raw));
}

// normalizeMarkupForMatch keeps an ESCAPED syntax character ("\*" projects to
// "*"), where projectRenderedText drops every one of them — so the same literal
// star was in one projection and not the other, and short selections around one
// lined up badly. Dropped here too, spaces closed up after it.
export function withoutDroppedCharacters(projected) {
  const chars = [];
  const map = [];
  for (let k = 0; k < projected.text.length; k += 1) {
    const ch = projected.text[k];
    if (NORMALIZE_DROP_CHARS.has(ch)) continue;
    if (ch === " " && (!chars.length || chars[chars.length - 1] === " ")) continue;
    chars.push(ch);
    map.push(projected.map[k]);
  }
  if (chars[chars.length - 1] === " ") {
    chars.pop();
    map.pop();
  }
  return { text: chars.join(""), map };
}

// normalizeMarkupForMatch over markdown whose entities have been decoded first,
// so "&amp;" projects to the one "&" a reader sees — with the map still pointing
// into the markdown as written (a decoded character maps to its entity's "&").
export function projectDecodedSource(raw) {
  if (!raw.includes("&")) return normalizeMarkupForMatch(raw);
  let decoded = "";
  const back = [];
  let at = 0;
  ENTITY_RE.lastIndex = 0;
  for (let m = ENTITY_RE.exec(raw); m; m = ENTITY_RE.exec(raw)) {
    for (let i = at; i < m.index; i += 1) back.push(i);
    decoded += raw.slice(at, m.index);
    const ch = decodeEntity(m[0]);
    for (let i = 0; i < ch.length; i += 1) back.push(m.index);
    decoded += ch;
    at = m.index + m[0].length;
  }
  for (let i = at; i < raw.length; i += 1) back.push(i);
  decoded += raw.slice(at);
  const projected = normalizeMarkupForMatch(decoded);
  return { text: projected.text, map: projected.map.map((i) => back[i] ?? raw.length) };
}

// For each index of `a`, the index of the same character in `b`, or -1 where
// `a` has something `b` does not. Greedy and monotonic: walk both while they
// agree; at a difference, skip the fewest characters (both sides together) that
// lands on CHAR_RESYNC_RUN agreeing characters again.
export function alignCharacters(a, b) {
  const pairs = new Int32Array(a.length).fill(-1);
  let i = 0;
  let j = 0;
  let matched = 0;
  const agree = (x, y, run) => {
    for (let k = 0; k < run; k += 1) if (a[x + k] !== b[y + k]) return false;
    return true;
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs[i] = j;
      matched += 1;
      i += 1;
      j += 1;
      continue;
    }
    let next = null;
    const reach = Math.min(CHAR_RESYNC_MAX, (a.length - i) + (b.length - j));
    for (let d = 1; d <= reach && !next; d += 1) {
      for (let di = 0; di <= d; di += 1) {
        const x = i + di;
        const y = j + (d - di);
        if (x >= a.length || y >= b.length) continue;
        const run = Math.min(CHAR_RESYNC_RUN, a.length - x, b.length - y);
        if (agree(x, y, run)) {
          next = { x, y };
          break;
        }
      }
    }
    if (!next) break;
    i = next.x;
    j = next.y;
  }
  return { pairs, matched };
}

// Where in the block's markdown a rendered position lands, as an offset into
// `raw`. A start lands ON the first character at or after the position; an end
// lands just after the last character before it. Characters the rendered text
// has and the markdown lacks (a heading number) resolve to their nearest
// matched neighbour in that same direction. Returns { offset, edge } where edge
// is "before" (nothing of the block precedes the position), "after" (nothing
// follows it) or "inside".
export function placeInBlock(rendered, renderedAt, raw, edge, { code = false } = {}) {
  const r = projectRenderedText(rendered);
  const m = projectSourceText(raw);
  // (A block whose text is all literal syntax characters — a heading that is
  // just "\*" — projects to nothing; the literal walks below still place it.)
  const same = r.text === m.text;
  const aligned = same ? null : alignCharacters(r.text, m.text);
  const rawIndexOf = (k) => (same ? k : aligned.pairs[k]);
  if (edge === "end") {
    // The last projected character strictly before the position.
    let k = -1;
    for (let lo = 0, hi = r.map.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (r.map[mid] < renderedAt) {
        k = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    // A projected space has no place of its own (it borrows the next
    // character's), so a boundary is never placed by one.
    while (k >= 0 && (r.text[k] === " " || rawIndexOf(k) < 0)) k -= 1;
    if (k < 0) {
      // Nothing projected before the boundary — but literal syntax characters
      // can be ("\* foo" selected up to its star).
      const lead = LINE_MARKER_LEAD_RE.exec(raw)?.[0].length || 0;
      const offset = takeLiteralTail(raw, code ? 0 : lead, rendered.slice(0, renderedAt), { code });
      return offset > lead ? { offset, edge: "inside" } : { offset: 0, edge: "before" };
    }
    const at = rawIndexOf(k);
    const offset = takeLiteralTail(raw, entityEndAt(raw, m.map[at] + 1), rendered.slice(r.map[k] + 1, renderedAt), { code });
    return { offset, edge: at >= m.text.length - 1 && offset >= raw.length ? "after" : "inside" };
  }
  // The first projected character at or after the position.
  let k = r.map.length;
  for (let lo = 0, hi = r.map.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    if (r.map[mid] >= renderedAt) {
      k = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  while (k < r.map.length && (r.text[k] === " " || rawIndexOf(k) < 0)) k += 1;
  if (k >= r.map.length) {
    // Nothing projected after it — but literal syntax characters can be ("foo
    // \*" selected from its star).
    const offset = takeLiteralHead(raw, raw.length, rendered.slice(renderedAt), { code });
    return offset < raw.length ? { offset, edge: "inside" } : { offset: raw.length, edge: "after" };
  }
  const at = rawIndexOf(k);
  const offset = takeLiteralHead(raw, m.map[at], rendered.slice(renderedAt, r.map[k]), { code });
  return { offset, edge: at === 0 && offset === m.map[0] ? "before" : "inside" };
}

// The projections drop every character that could be markdown syntax — "*",
// "[", "`" — so a boundary right next to one that is really there as TEXT (a
// literal "**" in a code block, the "]" of "array[0]", an escaped "\*") would
// land on the wrong side of it, and deleting "array[0]" left the "]". These
// take the rendered characters between the boundary and its nearest projected
// neighbour and walk the same characters in the markdown, an escaping
// backslash included.
export function takeLiteralTail(raw, from, renderedTail, { code = false } = {}) {
  const wanted = renderedTail.replace(/\s+/g, "");
  let at = entityEndAt(raw, from);
  for (const ch of wanted) {
    const look = nextRenderedChar(raw, at, ch, code);
    if (look < 0) break;
    at = look + 1;
  }
  return at;
}

export function takeLiteralHead(raw, from, renderedHead, { code = false } = {}) {
  const wanted = renderedHead.replace(/\s+/g, "");
  let at = from;
  for (let i = wanted.length - 1; i >= 0; i -= 1) {
    const look = previousRenderedChar(raw, at, wanted[i], code);
    if (look < 0) break;
    at = raw[look - 1] === "\\" ? look - 1 : look;
  }
  return at;
}

// An offset just past an entity's "&" (where a boundary after the one character
// "&amp;" renders as lands) moves past the whole entity.
export function entityEndAt(raw, at) {
  if (raw[at - 1] !== "&") return at;
  const m = /^(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/i.exec(raw.slice(at, at + 40));
  return m ? at + m[0].length : at;
}

// Between two characters a reader sees side by side, the markdown can hold
// things that render as nothing: spaces, a line break and the next line's
// marker ("- [x] ", "> "), and inline markup — a cloze's "}}", a link's
// "](…)", a "</mark>", a bold run's "**". These find `ch` past them, as itself
// or escaped, and answer its index (or -1). Markup is recognised the way
// markdown recognises it — a closer follows a non-space, an opener is followed
// by one, an escaped one is text — and not at all in code, where there is none.
// Bounded, so a literal that is not there is given up on quickly. Any markup
// stepped over is the inline repair's to put back (see erasureCuts).
export const UNRENDERED_SKIP_MAX = 120;

export function closerRunAt(raw, at) {
  const m = INLINE_CLOSER_LEAD_RE.exec(raw.slice(at, at + UNRENDERED_SKIP_MAX));
  if (!m || raw[at - 1] === "\\") return 0;
  if (/^[*_~`]/.test(m[0]) && (at === 0 || /\s/.test(raw[at - 1]))) return 0;
  return m[0].length;
}

export function openerRunBefore(raw, at) {
  const from = Math.max(0, at - UNRENDERED_SKIP_MAX);
  const m = INLINE_OPENER_TAIL_RE.exec(raw.slice(from, at));
  if (!m || !m[0].length) return 0;
  if (raw[from + m.index - 1] === "\\") return 0;
  if (/[*_~`]$/.test(m[0]) && (at >= raw.length || /\s/.test(raw[at]))) return 0;
  return m[0].length;
}

export function nextRenderedChar(raw, at, ch, code = false) {
  let look = at;
  const limit = Math.min(raw.length, at + UNRENDERED_SKIP_MAX);
  while (look < limit) {
    const closer = code ? 0 : closerRunAt(raw, look);
    if (closer) {
      look += closer;
      continue;
    }
    if (raw[look] === ch) return look;
    if (raw[look] === "\\" && raw[look + 1] === ch) return look + 1;
    if (raw[look] === " " || raw[look] === "\t") {
      look += 1;
      continue;
    }
    if (raw[look] === "\n") {
      look += 1;
      if (!code) look += LINE_MARKER_LEAD_RE.exec(raw.slice(look, lineEndAt(raw, look)))?.[0].length || 0;
      continue;
    }
    return -1;
  }
  return -1;
}

export function previousRenderedChar(raw, at, ch, code = false) {
  let look = at;
  const limit = Math.max(0, at - UNRENDERED_SKIP_MAX);
  while (look > limit) {
    const opener = code ? 0 : openerRunBefore(raw, look);
    if (opener) {
      look -= opener;
      continue;
    }
    if (raw[look - 1] === ch) return look - 1;
    const lineStart = lineStartAt(raw, look);
    if (!code && look > lineStart && LINE_MARKER_PREFIX_RE.test(raw.slice(lineStart, look))) {
      look = lineStart;
      continue;
    }
    if (raw[look - 1] === " " || raw[look - 1] === "\t" || raw[look - 1] === "\n") {
      look -= 1;
      continue;
    }
    return -1;
  }
  return -1;
}

// One boundary of a range → an offset in the source. Null when any step cannot
// be made exactly.
export function sourceOffsetForBoundary(context, node, offset, edge) {
  const point = descendToContent(context.view, node, offset, edge);
  if (!point) return null;
  const block = renderedBlockFor(context, point.node);
  if (!block || !block.roots.length) return null;
  const toSource = preparedSourceMap(context);
  const blockStart = toSource(block.preparedStart, "start");
  let blockEnd = toSource(block.preparedEnd, "end");
  const { source } = context;
  if (!(blockStart >= 0) || !(blockEnd <= source.length) || blockEnd < blockStart) return null;
  while (blockEnd > blockStart && /\s/.test(source[blockEnd - 1])) blockEnd -= 1;
  const raw = source.slice(blockStart, blockEnd);
  const stop = { node: point.node, offset: point.offset, edge };
  const upTo = renderedBlockText(block.roots, stop);
  if (upTo.at < 0) return null;
  // A block that renders text but maps to no markdown was mapped wrongly.
  if (!raw.trim() && projectRenderedText(upTo.text).text) return null;
  const code = /^ {0,3}(```|~~~)/.test(block.key) || block.roots.some((root) => root.nodeType === 1 && (root.tagName === "PRE" || Boolean(root.querySelector?.(":scope > pre"))));
  const placed = placeInBlock(upTo.text, upTo.at, raw, edge, { code });
  return {
    offset: blockStart + placed.offset,
    edge: placed.edge,
    blockStart,
    blockEnd,
    code,
    table: block.roots.some((root) => root.nodeType === 1 && (root.tagName === "TABLE" || Boolean(root.querySelector?.(":scope > table"))))
  };
}

// ── Lines, markers and whole blocks ────────────────────────────────────────

export function lineStartAt(source, at) {
  return source.lastIndexOf("\n", at - 1) + 1;
}

export function lineEndAt(source, at) {
  const nl = source.indexOf("\n", at);
  return nl === -1 ? source.length : nl;
}

// What may stand in front of a line's text without being text: indentation,
// quote markers, a heading's hashes, a list marker and a task box, a table
// row's opening pipe.
export const LINE_MARKER_PREFIX_SOURCE = String.raw`(?:[ \t]*>)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\|[ \t]*)?`;

export const LINE_MARKER_PREFIX_RE = new RegExp(`^${LINE_MARKER_PREFIX_SOURCE}$`);

export const LINE_MARKER_LEAD_RE = new RegExp(`^${LINE_MARKER_PREFIX_SOURCE}`);

// ...and behind it: a closing ATX run, a table row's closing pipe.
export const LINE_MARKER_SUFFIX_RE = /^[ \t]*(?:#+[ \t]*|\|[ \t]*)?$/;

export const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

// A line left holding nothing but a marker once its text has gone.
export const MARKER_ONLY_LINE_RE = /^(?:[ \t]*>)*[ \t]*(?:#{1,6}|[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]?\])?[ \t]*#*[ \t]*$|^(?:[ \t]*>)+[ \t]*$/;

// Settles a located [start, end) onto the source's own structure.
//
// First, an end that touches a block only at its very edge does not reach into
// it. A selection ending at the start of the next block (a triple-click, a drag
// that stops just past the last word) or starting at the end of the previous
// one names nothing of that block, so it must not take its marker or merge it.
//
// Then, with `lines`, a range that removes a line's whole text takes the line's
// marker and any closing hashes with it — the "## " a deleted heading used to
// leave behind, the "- " of a deleted bullet, a setext heading's underline.
// Wrapping callers leave `lines` off: their markers belong outside the wrap.
export function settleSourceRange(source, start, end, { lines = false } = {}) {
  let s = start;
  let e = end;
  // A start sitting at the end of a line's text, with the range going on to
  // later lines: begin at the next line's text instead.
  const tail = /^[ \t]*\n\s*/.exec(source.slice(s, Math.min(e, s + 4000)));
  if (tail && s + tail[0].length < e) {
    s += tail[0].length;
    const marker = LINE_MARKER_LEAD_RE.exec(source.slice(s, e));
    if (marker && s + marker[0].length < e) s += marker[0].length;
  }
  // An end sitting before a line's text (only marker and indentation before it
  // on its line), with the range starting on an earlier line: stop at the end of
  // the text before it instead.
  const endLine = lineStartAt(source, e);
  if (endLine > s && LINE_MARKER_PREFIX_RE.test(source.slice(endLine, e))) {
    let back = endLine;
    while (back > s && /\s/.test(source[back - 1])) back -= 1;
    if (back > s) e = back;
  }
  if (!lines || e <= s) return { start: s, end: e };
  const startLine = lineStartAt(source, s);
  const startLineEnd = lineEndAt(source, s);
  if (s > startLine && e >= startLineEnd - trailingMarkerLength(source, startLine, startLineEnd)
      && LINE_MARKER_PREFIX_RE.test(source.slice(startLine, s))) {
    s = startLine;
  }
  const lastLine = lineStartAt(source, e);
  const lastLineEnd = lineEndAt(source, e);
  if (s <= lastLine && e < lastLineEnd && LINE_MARKER_SUFFIX_RE.test(source.slice(e, lastLineEnd))) e = lastLineEnd;
  // A setext heading whose text has gone takes its underline with it.
  if (s <= lastLine && e === lastLineEnd && e < source.length) {
    const nextEnd = lineEndAt(source, e + 1);
    if (SETEXT_UNDERLINE_RE.test(source.slice(e + 1, nextEnd)) && source.slice(lastLine, e).trim()) e = nextEnd;
  }
  return { start: s, end: e };
}

export function trailingMarkerLength(source, lineStart, lineEnd) {
  const m = /[ \t]+#+[ \t]*$/.exec(source.slice(lineStart, lineEnd));
  return m ? m[0].length : 0;
}

// ── The whole selection ────────────────────────────────────────────────────

// Does the located markdown say roughly what was selected? A last guard against
// a block lookup that went wrong in a way nothing above could see: the two are
// projected the same way and must mostly agree.
export function sourceAgreesWithSelection(selectedText, markdown) {
  const a = projectRenderedText(selectedText || "").text;
  const b = projectSourceText(markdown || "").text;
  // Nothing but characters the projections drop ("]", "**" in code, an escaped
  // "\*"): compare those characters themselves.
  if (!a) {
    const literal = (text) => String(text).replace(/\\(?=[!-/:-@[-`{-~])/g, "").replace(/\s+/g, "");
    const unmarked = String(markdown || "").split("\n").map((l) => l.replace(LINE_MARKER_LEAD_RE, "")).join("\n");
    return Boolean(literal(selectedText)) && literal(selectedText) === literal(unmarked);
  }
  if (!b) return false;
  if (a === b) return true;
  const { matched } = alignCharacters(a, b);
  // Mostly the same characters; or, on a selection too short for a ratio to
  // mean much, the same characters give or take a handful (a task box's "x", a
  // heading number) that the markdown has around them.
  if (matched < 0.75 * Math.min(a.length, b.length)) return false;
  return matched >= 0.4 * Math.max(a.length, b.length) || Math.max(a.length, b.length) - matched <= 8;
}

// What a range covers, read the way a block's text is read (see
// emitRenderedBlockText) — the measure the located markdown is checked against.
// Not the description's own asText: that is built for a different job and
// reshapes a table it was cut from.
export function renderedRangeText(range) {
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  return renderedBlockText(Array.from(holder.childNodes)).text;
}

// An HTML entity renders as one character, so a boundary can land inside
// "&amp;" — and must not cut it in half.
export const ENTITY_RE = /&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/gi;

export function wholeEntities(source, start, end) {
  let s = start;
  let e = end;
  const around = (at) => {
    const from = Math.max(0, at - 40);
    ENTITY_RE.lastIndex = 0;
    const window = source.slice(from, at + 40);
    for (let m = ENTITY_RE.exec(window); m; m = ENTITY_RE.exec(window)) {
      const a = from + m.index;
      const b = a + m[0].length;
      if (a < at && at < b) return [a, b];
    }
    return null;
  };
  const head = around(s);
  if (head) s = head[0];
  const tail = around(e);
  if (tail) e = tail[1];
  return { start: s, end: e };
}

// The live range a selection description was taken from, if it still means the
// same thing: both ends still in the document, inside the same surface.
export function liveSelectionRange(sel) {
  const range = sel?.range;
  if (!range || range.collapsed) return null;
  const view = sel.view;
  if (!view || !view.isConnected) return null;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return null;
  if (!view.contains(range.startContainer) || !view.contains(range.endContainer)) return null;
  return range;
}

// [start, end) of a rendered selection in `source`, placed by its two ends.
// Returns { idx, end, needle, exact: true, code } or null. `lines` is for the
// callers that remove or move the text (see settleSourceRange).
export function sourceRangeForSelection(source, sel, { lines = false } = {}) {
  const range = liveSelectionRange(sel);
  if (!range) return null;
  const context = renderedSourceContext(sel.view, source);
  if (!context) return null;
  try {
    const snapped = snapRangeToAtomicBlocks(range);
    const from = sourceOffsetForBoundary(context, snapped.startContainer, snapped.startOffset, "start");
    const to = sourceOffsetForBoundary(context, snapped.endContainer, snapped.endOffset, "end");
    if (!from || !to || !(to.offset > from.offset)) return null;
    const ends = wholeEntities(context.source, from.offset, to.offset);
    if (!sourceAgreesWithSelection(renderedRangeText(snapped), context.source.slice(ends.start, ends.end))) return null;
    const settled = settleSourceRange(context.source, ends.start, ends.end, { lines });
    if (!(settled.end > settled.start)) return null;
    return {
      idx: settled.start,
      end: settled.end,
      needle: context.source.slice(settled.start, settled.end),
      exact: true,
      code: from.code && to.code && from.blockStart === to.blockStart,
      // The blocks the two ends are in, for an eraser that must not cut a code
      // fence in half (see eraseSourceRange).
      startBlock: { start: from.blockStart, end: from.blockEnd, code: from.code, table: from.table },
      endBlock: { start: to.blockStart, end: to.blockEnd, code: to.code, table: to.table }
    };
  } catch (error) {
    console.warn("Could not place the selection by its blocks", error);
    return null;
  }
}

// Where a selection that could not be placed exactly most likely is, for an
// action that hands it to the reader instead (the eraser opens the editor
// there). Either end on its own will do, and failing both, the start of the
// block the selection began in, found the way triple-click-to-edit finds it.
export function sourceGuessForSelection(source, sel) {
  try {
    const range = liveSelectionRange(sel);
    const context = range ? renderedSourceContext(sel.view, source) : null;
    if (context) {
      const from = sourceOffsetForBoundary(context, range.startContainer, range.startOffset, "start");
      const to = sourceOffsetForBoundary(context, range.endContainer, range.endOffset, "end");
      if (from && to && to.offset > from.offset) return { start: from.offset, end: to.offset };
      if (from || to) {
        const at = (from || to).offset;
        return { start: at, end: at };
      }
    }
    const block = sel?.anchorNode?.closest?.(NOTES_BLOCK_SELECTOR);
    const at = block && sel.view ? rawOffsetForRenderedBlock(sel.view, String(source ?? ""), block) : null;
    return Number.isFinite(at) ? { start: at, end: at } : null;
  } catch (_) {
    return null;
  }
}

// ── Erasing a placed range ─────────────────────────────────────────────────

// The opening and closing marker lengths of an inline construct's text, as
// inlineRegionsIn finds them: `code`, <tag>…</tag>, **…**, [label](target), ….
export function inlineConstructMarkers(text) {
  let m = /^(`+)/.exec(text);
  if (m && text.length > 2 * m[1].length && text.endsWith(m[1])) return { open: m[1].length, close: m[1].length };
  m = /^<([a-z]+)\b[^>]*>/i.exec(text);
  if (m) {
    const close = new RegExp(`</${m[1]}>$`, "i").exec(text);
    if (close) return { open: m[0].length, close: close[0].length };
  }
  m = /^!?\[/.exec(text);
  if (m) {
    const at = text.lastIndexOf("](");
    if (at > 0 && text.endsWith(")")) return { open: m[0].length, close: text.length - at };
  }
  if (/^(\*\*|__|~~|\{\{|\$\$)/.test(text)) return { open: 2, close: 2 };
  if (/^[*_$]/.test(text)) return { open: 1, close: 1 };
  return null;
}

// [start, end) widened or narrowed for the inline constructs it only partly
// covers, and the markers inside it to keep: cutting from inside **bold** to
// past it keeps the closing "**", so what is left of the bold is still bold and
// the rest of the line is not. A construct whose whole content goes loses its
// markers too, so nothing like "****" or "[](…)" is left behind.
export function erasureCuts(source, start, end, codeBlocks = []) {
  let s = start;
  let e = end;
  const keep = [];
  // Inside a fenced code block nothing is markup: a "**" there is two stars.
  const inCode = (at) => codeBlocks.some((block) => block && at >= block.start && at < block.end);
  for (const region of inlineRegionsNear(source, start, end)) {
    if (inCode(region.start) || inCode(region.end - 1)) continue;
    const markers = inlineConstructMarkers(source.slice(region.start, region.end));
    if (!markers) continue;
    // "\*literal\*" is two escaped stars, not emphasis — the region scan does
    // not know about escapes, so a cut beside one must not take the star.
    if (source[region.start - 1] === "\\" || source[region.end - markers.close - 1] === "\\") continue;
    const contentStart = region.start + markers.open;
    const contentEnd = region.end - markers.close;
    const startsInside = region.start < start && start < region.end;
    const endsInside = region.start < end && end < region.end;
    // All of its content: the construct goes whole, markers and link target
    // with it, rather than leaving "[](…)" or "****" behind.
    if (start <= contentStart && end >= contentEnd) {
      s = Math.min(s, region.start);
      e = Math.max(e, region.end);
      continue;
    }
    if (startsInside && endsInside) continue; // wholly inside: markers stay where they are
    // The space next to the cut goes with it, so what is left reads "**bold**"
    // rather than "**bold **" — emphasis cannot close after a space, and that
    // would print its asterisks.
    if (startsInside) {
      let from = start;
      while (from > contentStart && /[ \t]/.test(source[from - 1])) from -= 1;
      if (from <= contentStart) s = Math.min(s, region.start);
      else if (start < contentEnd) {
        s = Math.min(s, from);
        keep.push([contentEnd, region.end]);
      }
    }
    if (endsInside) {
      let to = end;
      while (to < contentEnd && /[ \t]/.test(source[to])) to += 1;
      if (to >= contentEnd) e = Math.max(e, region.end);
      else if (end > contentStart) {
        e = Math.max(e, to);
        keep.push([region.start, contentStart]);
      }
    }
  }
  const kept = keep.filter(([a, b]) => a >= s && b <= e && b > a).sort((x, y) => x[0] - y[0]);
  // A construct's kept closer met by the next one's kept opener, with only the
  // cut between them, would run together into a different marker ("*in" "*" "*"
  // "lta*" reads as "**"). The same marker on both sides means the two runs are
  // one now: drop both, and "*inlta*" is what is left.
  for (let k = kept.length - 2; k >= 0; k -= 1) {
    const [a1, b1] = kept[k];
    const [a2, b2] = kept[k + 1];
    if (b1 > a2) continue;
    if (source.slice(a1, b1) === source.slice(a2, b2) && /^[*_~`]+$/.test(source.slice(a1, b1))) kept.splice(k, 2);
  }
  return { start: s, end: e, keep: kept };
}

// Drop a line left holding nothing but a marker, on either side of `at`.
export function dropMarkerOnlyLine(text, at) {
  const start = lineStartAt(text, at);
  const end = lineEndAt(text, at);
  const line = text.slice(start, end);
  if (!line.trim() || !MARKER_ONLY_LINE_RE.test(line)) return { text, at };
  const after = end < text.length ? end + 1 : end;
  const before = after === end && start > 0 ? start - 1 : start;
  return { text: text.slice(0, before) + text.slice(after), at: before };
}

// Never more than one blank line where the cut joined two blocks, and none at
// the very top of the note.
export function tidyBlankLinesAt(text, at) {
  let s = at;
  let e = at;
  while (s > 0 && /\s/.test(text[s - 1])) s -= 1;
  while (e < text.length && /\s/.test(text[e])) e += 1;
  const run = text.slice(s, e);
  const newlines = (run.match(/\n/g) || []).length;
  if (s === 0) return text.slice(e);
  if (newlines <= 2) return text;
  const lead = /^[ \t]*/.exec(text.slice(lineStartAt(text, e), e))[0];
  return `${text.slice(0, s)}\n\n${lead}${text.slice(e)}`;
}

// The markers that close and open an inline construct, at the very start (or
// end) of a string — what a cut can leave a space up against.
export const INLINE_CLOSER_LEAD_RE = /^(?:<\/[a-z]+>|\*\*|__|~~|\}\}|\]\([^)\n]*\)|[*_`\]])+/i;

export const INLINE_OPENER_TAIL_RE = /(?:<[a-z]+\b[^>\n]*>|\*\*|__|~~|\{\{|!?\[|[*_`])+$/i;

// Does `text` begin by closing a construct? A tag, "}}" or "](target)" always
// does; "*", "_", "`" and "~~" only when nothing but space or punctuation
// follows them — "**word" opens one.
export function closesInlineConstruct(text) {
  const m = INLINE_CLOSER_LEAD_RE.exec(text);
  if (!m) return false;
  if (/^(?:<\/|\}\}|\]\()/.test(m[0])) return true;
  return /^(?:$|[\s.,;:!?)\]'"])/.test(text.slice(m[0].length));
}

// Does `text` end by opening one? A tag, "{{", "[" always does; "*", "_", "`"
// and "~~" only after a space or at a line's start — "bold**" closes one — and
// never when escaped.
export function opensInlineConstruct(text) {
  const m = INLINE_OPENER_TAIL_RE.exec(text);
  if (!m) return false;
  const lead = text[m.index - 1];
  if (lead === "\\") return false;
  if (/^(?:<[a-z]|\{\{|!?\[)/i.test(m[0])) return true;
  return lead === undefined || /\s/.test(lead);
}

// The source with a placed range removed. `code` is a range inside one fenced
// code block, where nothing is markup and every character goes exactly as
// selected — no marker or blank-line tidying either, since a "-" line or a run
// of blank lines in code is code.
// A cut that ends inside a fenced code block it did not start in keeps that
// block's opening fence, and one that starts inside a block it does not end in
// keeps the closing fence — otherwise the code that is left loses its fence and
// every line after it turns into code (or out of it). The kept spans, as
// [from, to) pairs inside [start, end).
export function fenceSpansToKeep(source, start, end, startBlock, endBlock) {
  const keep = [];
  // Ends inside the code (before the closing fence line), having started before
  // the block: the opening fence stays.
  if (endBlock?.code && endBlock.start > start && endBlock.start < end && end <= lineStartAt(source, endBlock.end)) {
    let from = endBlock.start;
    while (from > start && /\s/.test(source[from - 1])) from -= 1;
    const open = lineEndAt(source, endBlock.start);
    if (open < end) keep.push([from, Math.min(end, open + 1)]);
  }
  // Starts inside the code (after the opening fence line) and runs to or past
  // the closing fence: the closing fence stays.
  if (startBlock?.code && start > lineEndAt(source, startBlock.start) && startBlock.end > start && startBlock.end <= end) {
    const closeLine = lineStartAt(source, startBlock.end);
    if (closeLine > start && /^ {0,3}(```|~~~)/.test(source.slice(closeLine, startBlock.end))) {
      let to = startBlock.end;
      while (to < end && /\s/.test(source[to])) to += 1;
      keep.push([closeLine - 1, to]);
    }
  }
  return keep;
}

// A table the cut covers only part of keeps its shape: the selected cells are
// emptied, the way a word processor clears them, rather than the pipes and the
// "| --- |" row going too and the rest of the table printing as text. Its line
// breaks and the blank line between it and whatever the cut joins it to stay as
// well, so it is still a block of its own.
export function tableSpansToKeep(source, start, end, block) {
  if (!block?.table || (start <= block.start && end >= block.end)) return [];
  const keep = [];
  const from = Math.max(start, block.start);
  const to = Math.min(end, block.end);
  if (start < block.start) {
    let ws = block.start;
    while (ws > start && /\s/.test(source[ws - 1])) ws -= 1;
    keep.push([ws, block.start]);
  }
  for (let line = lineStartAt(source, from); line < to; line = lineEndAt(source, line) + 1) {
    const lineEnd = lineEndAt(source, line);
    if (NORMALIZE_TABLE_DELIM_LINE_RE.test(source.slice(line, lineEnd))) {
      keep.push([Math.max(line, from), Math.min(lineEnd, to)]);
    } else {
      for (let i = Math.max(line, from); i < Math.min(lineEnd, to); i += 1) {
        if (source[i] === "|" && source[i - 1] !== "\\") keep.push([source[i - 1] === " " ? i - 1 : i, source[i + 1] === " " ? i + 2 : i + 1]);
      }
    }
    if (lineEnd >= from && lineEnd < to) keep.push([lineEnd, lineEnd + 1]);
    if (lineEnd >= source.length) break;
  }
  if (end > block.end) {
    let ws = block.end;
    while (ws < end && /\s/.test(source[ws])) ws += 1;
    keep.push([block.end, ws]);
  }
  return keep;
}

export const NORMALIZE_TABLE_DELIM_LINE_RE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

// [start, end) with the `keep` spans taken out of it: the pieces to remove.
export function cutsAround(start, end, keep) {
  const kept = keep
    .map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const cuts = [];
  let at = start;
  for (const [a, b] of kept) {
    if (a > at) cuts.push([at, a]);
    at = Math.max(at, b);
  }
  if (end > at) cuts.push([at, end]);
  return cuts;
}

export function eraseSourceRange(source, start, end, { code = false, startBlock = null, endBlock = null } = {}) {
  if (code) return source.slice(0, start) + source.slice(end);
  const structure = [
    ...fenceSpansToKeep(source, start, end, startBlock, endBlock),
    ...tableSpansToKeep(source, start, end, startBlock),
    ...(endBlock && startBlock && endBlock.start === startBlock.start ? [] : tableSpansToKeep(source, start, end, endBlock))
  ];
  const wholeLines = start === lineStartAt(source, start) && (end === source.length || source[end] === "\n");
  if (wholeLines && !structure.length) {
    const tail = source[end] === "\n" ? end + 1 : end;
    let text = source.slice(0, start) + source.slice(tail);
    let at = start;
    if (tail === end && start > 0) {
      // The last line of the note went: take the line break in front of it too.
      text = source.slice(0, start).replace(/\s+$/, "\n") + source.slice(tail);
      at = Math.min(at, text.length);
    }
    return tidyBlankLinesAt(dropMarkerOnlyLine(text, at).text, Math.min(at, text.length));
  }
  const inline = erasureCuts(source, start, end, [startBlock, endBlock].filter((block) => block?.code));
  const cuts = cutsAround(inline.start, inline.end, [...inline.keep, ...structure]);
  if (!cuts.length) return source;
  let before = "";
  let at = 0;
  const seams = [];
  for (const [a, b] of cuts) {
    before += source.slice(at, a);
    seams.push(before.length);
    at = b;
  }
  let after = source.slice(at);
  // Whatever survives of the first and last lines joins up the way any editor
  // joins it: exactly what is left, so a cut from the middle of a heading into
  // the paragraph below leaves one heading line, and a cut from mid-word to
  // mid-word closes up. A placed range never starts or ends on whitespace (see
  // projectRenderedText), so what is left to tidy is the space either side of
  // the cut: doubled between two words, stranded at a line's start, or caught
  // inside a construct's markers ("<mark>marked </mark>", "** bold**").
  if (!before || /\n[ \t]*$/.test(before)) after = after.replace(/^[ \t]+/, "");
  else if (/[ \t]$/.test(before) && /^[ \t]/.test(after)) after = after.replace(/^[ \t]+/, "");
  else if (/[ \t]$/.test(before) && closesInlineConstruct(after)) before = before.replace(/[ \t]+$/, "");
  else if (/^[ \t]/.test(after) && opensInlineConstruct(before)) after = after.replace(/^[ \t]+/, "");
  const seam = before.length;
  // Where the cut ends inside a code block, the joined line is code: nothing
  // about it is a marker, a block boundary or a blank line to tidy. The same
  // goes for the first seam of a cut that starts inside one.
  const endsInCode = Boolean(endBlock?.code && end > endBlock.start);
  const startsInCode = Boolean(startBlock?.code && start > startBlock.start && start < startBlock.end);
  let text = endsInCode ? before + after : keepFollowingBlockApart(before + after, seam);
  // Each seam, from the last back so every earlier position still holds: the
  // spaces a cut leaves at the end of a line go (two of them would be a hard
  // line break), then a line left holding only its marker, then the blank lines
  // around it.
  const positions = [...new Set(seams)].sort((x, y) => y - x);
  for (const p of positions) {
    if ((endsInCode && p === seam) || (startsInCode && p === seams[0])) continue;
    let at = Math.min(p, text.length);
    if (at === text.length || text[at] === "\n") {
      let from = at;
      while (from > 0 && (text[from - 1] === " " || text[from - 1] === "\t")) from -= 1;
      text = text.slice(0, from) + text.slice(at);
      at = from;
    }
    const dropped = dropMarkerOnlyLine(text, at);
    text = tidyBlankLinesAt(dropped.text, Math.min(dropped.at, dropped.text.length));
  }
  return text;
}

// The line after a join must still start the block it started. A paragraph
// line now holding the tail of a list item, a heading or a table row would
// otherwise swallow it: "3. item" cannot interrupt a paragraph (only a list
// numbered from 1 can), a table row cannot either, and "---" under paragraph
// text turns it into a heading. A blank line between them keeps both.
export function keepFollowingBlockApart(text, at) {
  const lineEnd = lineEndAt(text, at);
  if (lineEnd >= text.length) return text;
  const line = text.slice(lineStartAt(text, at), lineEnd);
  if (!line.trim() || STARTS_OWN_BLOCK_RE.test(line) || /^(?: {4}|\t)/.test(line)) return text;
  const next = text.slice(lineEnd + 1, lineEndAt(text, lineEnd + 1));
  if (!next.trim()) return text;
  if (!(STARTS_OWN_BLOCK_RE.test(next) || SETEXT_UNDERLINE_RE.test(next))) return text;
  return `${text.slice(0, lineEnd)}\n${text.slice(lineEnd)}`;
}

// A line that starts a block of its own: a list item, a quote, a heading, a
// table row, a fence.
export const STARTS_OWN_BLOCK_RE = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]|[ \t]*>|[ \t]*#{1,6}[ \t]|[ \t]*\||[ \t]*(?:```|~~~))/;
