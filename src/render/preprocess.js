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
