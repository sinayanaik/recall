// The markdown -> sanitised HTML pipeline, and the fenced blocks (mermaid,
// nomnoml) that are lifted out of it before marked ever sees them.

import { markdownLibrariesReady } from "../core/lib-guard.js?v=__BUILD__";
import { encodeAttribute, escapeHtml } from "../core/text.js?v=__BUILD__";
import { normalizeMarkdown } from "../import/parse-cards.js?v=__BUILD__";
import { normalizeCitations, protectInline, renderImageRows } from "./inline.js?v=__BUILD__";

// ── Diagram sizing ─────────────────────────────────────────────────────────
// A mermaid/nomnoml diagram is as resizable as an image, and its size has to
// survive in the markdown like an image's does. An image carries it in a raw
// <img style="--notes-img-w:…">; a diagram is a fenced code block, which has
// nowhere to hang an attribute — except its info string. So a resized diagram
// is stored as ```mermaid w=520, which every renderer here already accepts
// (the fence is matched on /\bmermaid\b/, not on an exact language) and which
// no other markdown tool chokes on. The parsed width rides to the DOM as an
// inline width on the .mermaid/.nomnoml-diagram element, so it applies to the
// generated <svg> (which is stretched to its container) without a JS pass, and
// exports/prints inherit it for free.
export const DIAGRAM_WIDTH_MIN = 80;

export const DIAGRAM_WIDTH_MAX = 4000;

// ── The one fence scanner ──────────────────────────────────────────────────
//
// The renderer walks it to turn diagram fences into elements, findSourceImages
// walks it to know which `![](…)` are pictures and which are text, and the
// diagram grip walks it to find the fence behind the Nth drawing on screen.
// Sharing one scanner is what keeps those three in lockstep.
//
// It used to be one regex — ```[ \t]*([^\n]*)\n([\s\S]*?)``` — which paired
// ``` markers BY COUNT, wherever they sat. Four ways that disagrees with the
// markdown parser downstream of it, each verified against marked:
//
//   • it is not line-anchored, so a bare ``` written INSIDE A SENTENCE ("wrap
//     it in ``` fences") opens a fence. Everything up to the next ``` in the
//     note is then treated as code — the renderer emits that whole span raw,
//     so every cloze, every $formula$, every [[note link]] and every citation
//     in it silently stops working, and every image in it loses its resize
//     grip and its delete button. One stray marker inverts code and prose for
//     the rest of the note, which is exactly the shape of a note ABOUT code;
//   • `~~~` is a fence to CommonMark and was not one here, so an image inside
//     one got controls that would have rewritten text nobody can see;
//   • a closing fence has to be AT LEAST as long as its opener, so ```` ```` ````
//     wrapping a ``` block split in the wrong place;
//   • an unclosed fence runs to the end of the document; this stopped at the
//     opener and read the rest of the note as prose.
//
// So it follows CommonMark instead: an opener is up to three spaces of indent
// then three or more ` or ~ (a backtick fence's info string may not itself
// contain a backtick); the closer is the same character, at least as long, on
// a line of its own; an unclosed fence takes everything after it.
export const FENCE_OPEN_SOURCE = "^([^\\S\\n]{0,3})(`{3,}|~{3,})[^\\S\\n]*([^\\n]*)$";

export function fenceOpenPattern() {
  return new RegExp(FENCE_OPEN_SOURCE, "gm");
}

// Every fenced block in `source`, in document order, as
// { start, end, headEnd, bodyStart, bodyEnd, indent, marker, info, body }.
//
//   start    the first character of the opening line, indent included
//   headEnd  the end of the opening line (the index of its newline)
//   end      one past the closing line, or the length of the source
//
// `start`..`end` is the slice the renderer re-emits verbatim, so a splice on
// it cannot disturb the text around the block.
export function scanFences(source) {
  const text = String(source || "");
  const found = [];
  // Cheapest possible reject: most notes have no fence at all, and this runs
  // on the tail of every render of every surface.
  if (!text.includes("```") && !text.includes("~~~")) return found;
  const openers = fenceOpenPattern();
  let opener;
  while ((opener = openers.exec(text))) {
    const [line, indent, marker, info] = opener;
    // "```js`" is not a fence — a backtick fence's info string may not hold a
    // backtick, which is what stops an inline code span opening one.
    if (marker[0] === "`" && info.includes("`")) {
      openers.lastIndex = opener.index + line.length;
      continue;
    }
    const start = opener.index;
    const headEnd = start + line.length;
    const newline = text.indexOf("\n", headEnd);
    if (newline === -1) {
      // The opener is the last line of the note: an empty, unclosed block.
      found.push({ start, end: text.length, headEnd, bodyStart: text.length, bodyEnd: text.length, indent, marker, info, body: "" });
      break;
    }
    const bodyStart = newline + 1;
    const closer = new RegExp(`^[^\\S\\n]{0,3}${marker[0]}{${marker.length},}[^\\S\\n]*$`, "m");
    const rest = text.slice(bodyStart);
    const hit = closer.exec(rest);
    const bodyEnd = hit ? bodyStart + hit.index : text.length;
    const end = hit ? bodyEnd + hit[0].length : text.length;
    found.push({ start, end, headEnd, bodyStart, bodyEnd, indent, marker, info, body: text.slice(bodyStart, bodyEnd) });
    openers.lastIndex = end;
  }
  return found;
}

// ── ...and everything else the renderer will not read as markdown ──────────
//
// scanFences answers the question the RENDERER asks: where are the fenced
// blocks, so preprocessSpecialBlocks can re-emit one verbatim and lift the
// diagram ones out. findSourceImages asks a bigger one — where is text a reader
// will never see as a picture — and fences are only part of that answer. marked
// treats five more shapes as code or as raw HTML, and an `![](…)` inside any of
// them renders as TEXT:
//
//   • an indented code block (four spaces or a tab);
//   • a fence inside a blockquote, whose opener carries a "> " prefix;
//   • a fence inside a list item, indented past the three spaces a top-level
//     fence may have;
//   • a closed HTML comment, which DOMPurify removes outright;
//   • a <pre>/<script>/<style>/<textarea> block, emitted verbatim.
//
// The scan reported an image for every one of those. A phantom is not harmless:
// it shares its URL with the real picture whenever a note quotes its own
// markdown, which inflates that URL's copy count — enough on a lazily built
// note to skip the real picture's controls altogether — and on a whole note it
// can bind the grip to the slice inside the code block, so a resize rewrites
// text nobody can see. That is exactly the failure src/render/inline.js's header
// promises never to make.
//
// Every rule below leans one way on purpose. Calling real prose "code" would
// take a picture's controls away, which is the bug being fixed, so anything
// ambiguous is left as prose — a phantom is the tolerable error here and a
// missing grip is not. tools/image-controls-check.mjs holds marked up as the
// oracle for both directions.

// A blockquote's marker run, which a fence inside one sits behind.
export const QUOTE_PREFIX_SOURCE = "^[^\\S\\n]{0,3}(?:>[^\\S\\n]?)+";

// A list item's own opener. Only used to know whether a list is OPEN, because
// while one is, an indented line is its continuation rather than a code block
// and a fence may be indented as far as the item's content column.
export const LIST_ITEM_SOURCE = "^[^\\S\\n]{0,3}(?:[-+*]|\\d{1,9}[.)])(?:[^\\S\\n]|$)";

// CommonMark's type-1 HTML block: everything to the closing tag is verbatim.
export const HTML_VERBATIM_TAGS = ["pre", "script", "style", "textarea"];

// One line of `text`, as [start, end) of its content and the index the next line
// starts at.
function lineAt(text, start) {
  const newline = text.indexOf("\n", start);
  const end = newline === -1 ? text.length : newline;
  return { end, next: newline === -1 ? text.length : newline + 1 };
}

// A fence opener on `line`, or null. `maxIndent` is how far in it may sit: three
// spaces at the top level, and as far as you like inside a list item, whose own
// content column this scan does not track exactly.
function fenceOpenOn(line, maxIndent) {
  const match = line.match(/^([^\S\n]*)(`{3,}|~{3,})[^\S\n]*(.*)$/);
  if (!match) return null;
  if (match[1].length > maxIndent) return null;
  // "```js`" is not a fence — same rule scanFences applies, and for the same
  // reason: it is what stops an inline code span opening one.
  if (match[2][0] === "`" && match[3].includes("`")) return null;
  return { indent: match[1], marker: match[2] };
}

function isFenceCloseOn(line, marker) {
  // Assembled rather than written as one template literal: tools/js-scan.mjs
  // reads this file as TEXT (see tools/image-controls-check.mjs), and a "$"
  // sitting immediately in front of the closing backtick reads to its scanner
  // as the start of an interpolation.
  const run = marker[0] + "{" + marker.length + ",}";
  return new RegExp("^[^\\S\\n]*" + run + "[^\\S\\n]*" + "$").test(line);
}

// Merged, sorted, non-overlapping. The callers walk this the way they walked
// scanFences, so an overlap (an HTML comment inside a fence) has to become one
// region rather than two that interleave.
export function mergeRanges(ranges) {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

// Every CLOSED `<!-- … -->` between `from` and `to`. Scanned as text rather
// than line by line, because a comment is as legal in the middle of a paragraph
// as it is on its own line, and DOMPurify strips it either way.
//
// Two bounds, both of them there to stop this hiding real pictures rather than
// to tidy it up:
//
//   • `from`/`to` are the gaps BETWEEN the code regions the line walk already
//     found. A `<!--` written inside a fenced block is text — a note ABOUT HTML
//     has one — and reading it as a comment would carry the region out past the
//     fence and over the prose after it;
//   • an UNCLOSED `<!--` ends the walk of its gap. CommonMark runs its HTML
//     block to the end of the document, so following that rule would make every
//     picture in the rest of the note invisible to the scan on the strength of
//     one stray marker — the same shape of failure a stray ``` used to cause
//     (see the header on scanFences), and the reason that one was rewritten.
//     Nothing after it in the gap is claimed either, because the next `-->` in
//     the note belongs to some LATER comment and pairing with it would take the
//     region across everything in between. Both cost a phantom at worst.
export function scanHtmlComments(text, from = 0, to = text.length) {
  const found = [];
  let at = text.indexOf("<!--", from);
  while (at !== -1 && at < to) {
    const close = text.indexOf("-->", at + 4);
    if (close === -1 || close + 3 > to) break;
    found.push({ start: at, end: close + 3 });
    at = text.indexOf("<!--", close + 3);
  }
  return found;
}

export function scanCodeRegions(source) {
  const text = String(source || "");
  const regions = [];
  const quotePrefix = new RegExp(QUOTE_PREFIX_SOURCE);
  const listItem = new RegExp(LIST_ITEM_SOURCE);
  const verbatimOpen = new RegExp(`^[^\\S\\n]{0,3}<(${HTML_VERBATIM_TAGS.join("|")})\\b`, "i");

  let at = 0;
  let listOpen = false;
  // The document starts where a block can start, so a first line that is
  // indented four spaces is a code block just as one after a blank line is.
  let afterBlank = true;

  // A block starting hard against the left margin ends whatever list was open,
  // the same way a paragraph there does. Every branch below has to say this for
  // itself, because each one continues past the tracking at the foot of the
  // loop — and a list left open forever makes every later indented chunk look
  // like a continuation rather than the code it is.
  const closeListAt = (line) => { if (afterBlank && !/^[^\S\n]/.test(line)) listOpen = false; };

  while (at < text.length) {
    const { end, next } = lineAt(text, at);
    const line = text.slice(at, end);
    const blank = !line.trim();

    if (blank) {
      // A blank line does not close a list — an item's second paragraph is
      // still the item's.
      afterBlank = true;
      at = next;
      continue;
    }

    const quoted = line.match(quotePrefix);
    if (quoted) {
      const opener = fenceOpenOn(line.slice(quoted[0].length), Infinity);
      if (opener) {
        // Bounded by the blockquote itself: the region ends at the closing
        // fence, or at the first line that has left the quote, whichever comes
        // first. Without that bound one stray "> ```" would swallow the rest of
        // the note and take every picture's controls with it.
        let cursor = next;
        let regionEnd = end;
        while (cursor < text.length) {
          const step = lineAt(text, cursor);
          const inner = text.slice(cursor, step.end);
          const innerQuote = inner.match(quotePrefix);
          if (!innerQuote) break;
          regionEnd = step.end;
          cursor = step.next;
          if (isFenceCloseOn(inner.slice(innerQuote[0].length), opener.marker)) break;
        }
        regions.push({ start: at, end: regionEnd });
        at = cursor;
        closeListAt(line);
        afterBlank = false;
        continue;
      }
      closeListAt(line);
      afterBlank = false;
      at = next;
      continue;
    }

    const opener = fenceOpenOn(line, listOpen ? Infinity : 3);
    if (opener) {
      let cursor = next;
      let regionEnd = text.length;
      let closed = false;
      while (cursor < text.length) {
        const step = lineAt(text, cursor);
        const inner = text.slice(cursor, step.end);
        if (isFenceCloseOn(inner, opener.marker)) {
          regionEnd = step.end;
          cursor = step.next;
          closed = true;
          break;
        }
        // A fence opened INSIDE a list item is only trusted as far as that
        // list: the first unindented line ends it. An unclosed top-level fence
        // still runs to the end of the note, which is what CommonMark says and
        // what scanFences already does.
        if (opener.indent.length >= 4 && inner.trim() && !/^[^\S\n]/.test(inner)) {
          regionEnd = cursor;
          break;
        }
        cursor = step.next;
      }
      if (!closed && cursor >= text.length) regionEnd = text.length;
      regions.push({ start: at, end: regionEnd });
      at = Math.max(next, cursor);
      closeListAt(line);
      afterBlank = false;
      continue;
    }

    if (verbatimOpen.test(line)) {
      const tag = line.match(verbatimOpen)[1].toLowerCase();
      const close = new RegExp(`</${tag}\\s*>`, "i");
      let cursor = at;
      let regionEnd = text.length;
      while (cursor < text.length) {
        const step = lineAt(text, cursor);
        const hit = close.test(text.slice(cursor, step.end));
        cursor = step.next;
        if (hit) { regionEnd = step.end; break; }
      }
      regions.push({ start: at, end: regionEnd });
      at = Math.max(next, cursor);
      closeListAt(line);
      afterBlank = false;
      continue;
    }

    // An indented chunk is a code block only where a block can start and only
    // outside a list — inside one the same indentation is the item's own
    // continuation, and reading that as code is how a real picture in a bullet
    // would lose its grip.
    if (afterBlank && !listOpen && /^(?: {4}|\t)/.test(line)) {
      let cursor = next;
      let regionEnd = end;
      while (cursor < text.length) {
        const step = lineAt(text, cursor);
        const inner = text.slice(cursor, step.end);
        if (inner.trim() && !/^(?: {4}|\t)/.test(inner)) break;
        // Trailing blank lines belong to whatever comes next, not to the block.
        if (inner.trim()) regionEnd = step.end;
        cursor = step.next;
      }
      regions.push({ start: at, end: regionEnd });
      at = cursor;
      afterBlank = false;
      continue;
    }

    if (listItem.test(line)) listOpen = true;
    else closeListAt(line);
    afterBlank = false;
    at = next;
  }

  // Comments last, and only in what the walk left as prose — see
  // scanHtmlComments for why that bound matters.
  const blocks = mergeRanges(regions);
  const comments = [];
  let gap = 0;
  for (const block of blocks) {
    comments.push(...scanHtmlComments(text, gap, block.start));
    gap = Math.max(gap, block.end);
  }
  comments.push(...scanHtmlComments(text, gap, text.length));
  return mergeRanges(blocks.concat(comments));
}

export function parseDiagramWidth(info) {
  const match = String(info || "").match(/\b(?:w|width)\s*=\s*(\d{2,4})\b/i);
  if (!match) return null;
  const px = parseInt(match[1], 10);
  if (!Number.isFinite(px)) return null;
  return Math.min(DIAGRAM_WIDTH_MAX, Math.max(DIAGRAM_WIDTH_MIN, px));
}

// `<div class="mermaid …">` for one fence, sized if its info string says so.
// `has-custom-size` is the same marker a resized image carries, so the resize
// grip reads a diagram's current width back the same way.
export function diagramOpenTag(className, info) {
  const px = parseDiagramWidth(info);
  if (!px) return `<div class="${className}"`;
  return `<div class="${className} has-custom-size" style="--notes-img-w:${px}px; width:${px}px"`;
}

// Rewrites a fence's info string to carry `w=<px>` (replacing any width already
// there), keeping the declared language and any other words intact.
export function fenceInfoWithWidth(info, px) {
  const cleaned = String(info || "").replace(/\s*\b(?:w|width)\s*=\s*\d+\b/gi, "").trim();
  return px ? `${cleaned} w=${px}`.trim() : cleaned;
}

export function preprocessSpecialBlocks(markdown) {
  const source = normalizeMarkdown(markdown || "");
  let output = "";
  let lastIndex = 0;

  for (const fence of scanFences(source)) {
    output += protectInline(renderImageRows(normalizeCitations(source.slice(lastIndex, fence.start))));
    if (/\bmermaid\b/i.test(fence.info)) {
      output += `${diagramOpenTag("mermaid", fence.info)} data-diagram="${encodeAttribute(fence.body.trim())}"></div>`;
    } else if (/\bnomnoml\b/i.test(fence.info)) {
      output += `${diagramOpenTag("nomnoml-diagram", fence.info)} data-diagram="${encodeAttribute(fence.body.trim())}"></div>`;
    } else {
      output += source.slice(fence.start, fence.end);
    }
    lastIndex = fence.end;
  }

  output += protectInline(renderImageRows(normalizeCitations(source.slice(lastIndex))));
  return output;
}

// Rewrite Google Drive "share/viewer" links to a directly-embeddable image URL.
// A link like https://drive.google.com/file/d/FILE_ID/view is a viewer page, not an
// image, so it renders as a broken <img>. The /thumbnail?id=…&sz=w1000 route serves the
// actual image bytes for public files (the old uc?export=view route now hits a virus-scan
// interstitial). Returns the original url when it isn't a recognizable Drive link.
export function normalizeImageUrl(url) {
  if (!url) return url;
  const m = String(url).match(
    /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^&]*&)*id=|thumbnail\?(?:[^&]*&)*id=)([\w-]{20,})/
  );
  if (!m) return url;
  return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
}

export const SANITIZE_CONFIG = {
  ADD_TAGS: ["foreignObject", "font", "u", "del", "kbd"],
  // data-note-target / data-note-title carry a [[note reference]] through to the
  // click handler. Without them here DOMPurify strips both and the link renders
  // as inert text — the failure is silent, which is why it is called out.
  ADD_ATTR: ["target", "rel", "class", "data-tex", "data-diagram", "data-note-target", "data-note-title", "style", "color", "face", "tabindex", "role", "aria-label"],
  // DOMPurify's default URI allowlist would strip `recall-img:` and a
  // not-yet-uploaded image would render as a broken <img> with no src. This
  // is DOMPurify's default expression with exactly one scheme added — nothing
  // else is widened. In particular `data:` is deliberately NOT here: DOMPurify
  // already permits data: URIs on <img> and friends through its own
  // DATA_URI_TAGS path, and listing it here would additionally allow
  // `data:text/html` in an href, which is a script-execution vector.
  // recall-img: resolves only to a blob this app itself put in IndexedDB
  // (see hydrateLocalImages) and can't reference anything remote.
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|recall-img):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
};

// Second half of the pipeline, split out so the incremental renderer can run it
// on ONE changed block: preprocessSpecialBlocks has already been applied to the
// whole document (its math/cloze/code protection reads across block boundaries,
// so it must never be re-run on a fragment of its own output).
// The one place marked and DOMPurify are actually invoked for a whole document,
// and therefore the one place worth guarding. If either failed to load, showing
// the markdown SOURCE is a far better answer than throwing: the note is still
// readable, still selectable, still copyable, and the boot guard has already
// said on screen which file is missing. Throwing here took the whole view down
// and left an empty pane with nothing to explain it.
export function safeHtmlFromPrepared(prepared) {
  if (!markdownLibrariesReady()) return `<pre class="md-unrendered">${escapeHtml(prepared)}</pre>`;
  return DOMPurify.sanitize(marked.parse(prepared), SANITIZE_CONFIG);
}

export function markdownToSafeHtml(markdown) {
  return safeHtmlFromPrepared(preprocessSpecialBlocks(markdown || ""));
}
