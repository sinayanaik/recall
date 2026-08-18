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

// The one fence scanner. The renderer walks it to turn diagram fences into
// elements and the resize grip walks it to find the fence behind the Nth
// diagram on screen — sharing the pattern is what guarantees those two walks
// stay in lockstep. Capture 1 is the info string, capture 2 the body.
export const FENCE_PATTERN_SOURCE = "```[ \\t]*([^\\n]*)\\n([\\s\\S]*?)```";

export function fencePattern() {
  return new RegExp(FENCE_PATTERN_SOURCE, "g");
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
  const fences = fencePattern();
  let output = "";
  let lastIndex = 0;
  let match;

  while ((match = fences.exec(source))) {
    output += protectInline(renderImageRows(normalizeCitations(source.slice(lastIndex, match.index))));
    if (/\bmermaid\b/i.test(match[1])) {
      output += `${diagramOpenTag("mermaid", match[1])} data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
    } else if (/\bnomnoml\b/i.test(match[1])) {
      output += `${diagramOpenTag("nomnoml-diagram", match[1])} data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
    } else {
      output += match[0];
    }
    lastIndex = fences.lastIndex;
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
