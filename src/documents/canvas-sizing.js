// What something put on the Canvas is sized by: the Canvas, not where it came
// from. Pure — markdown in, markdown out — so tools/canvas-feed-check.mjs
// drives every rule here from Node.
//
// A picture in the Notes carries the pixel width it was dragged to there
// (`<img … style="width:640px">`, src/images/surface-controls.js), a diagram
// its `w=600` (src/render/preprocess.js), a coloured phrase may carry a font
// size, and a web page's HTML carries whatever the site set. Taken onto a
// Canvas page as they were, they came out the size they were in the Notes or
// on the site. canvasSizedMarkdown takes those sizes off, and the Block is
// then drawn in ◐ Canvas's type at the width ◐ Canvas gives its kind
// (canvasDropWidthPercent, ./block-measure.js). Colour, face and background
// stay: those are how the words look, not how big they are.
//
// pdfPlainToMarkdown is the other half: words with no markup at all (a PDF
// reader, another app) laid out as a PDF tab's own words are.

// ── Taking sizes off ──────────────────────────────────────────────────────

function attrOf(tag, name) {
  const match = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  if (!match) return "";
  return match[2] ?? match[3] ?? match[4] ?? "";
}

function unescapeAttr(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// `![alt](src)` for an <img> tag: the picture without the size it was given.
function imgTagToMarkdown(tag) {
  const src = unescapeAttr(attrOf(tag, "src")).trim();
  if (!src) return "";
  const alt = unescapeAttr(attrOf(tag, "alt")).replace(/[[\]]/g, "").trim();
  const url = /[\s()]/.test(src) ? `<${src.replace(/>/g, "%3E")}>` : src;
  return `![${alt}](${url})`;
}

// The declarations of a style attribute that set a size.
const SIZE_PROPERTY_RE = /^\s*(?:font-size|line-height|width|height|min-width|max-width|min-height|max-height|zoom|--notes-img-w)\s*:/i;

function styleWithoutSizes(style) {
  return String(style || "")
    .split(";")
    .filter((part) => part.trim() && !SIZE_PROPERTY_RE.test(part))
    .map((part) => part.trim())
    .join("; ");
}

// A fence's info string without the `w=` a resized diagram carries.
export function fenceInfoWithoutWidth(info) {
  return String(info || "").replace(/\s*\b(?:w|width)\s*=\s*\d+\b/gi, "").trim();
}

// The markdown, its sizes taken off. Inside a code fence nothing is touched
// but the fence's own info string: `<img style="width:…">` in a listing is
// the listing's words.
export function canvasSizedMarkdown(md) {
  const text = String(md ?? "");
  const out = [];
  let fence = null;
  text.split("\n").forEach((line) => {
    const open = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (open && open[2][0] === fence[0] && open[2].length >= fence.length && !open[3].trim()) fence = null;
      out.push(line);
      return;
    }
    if (open) {
      fence = open[2];
      out.push(`${open[1]}${open[2]}${fenceInfoWithoutWidth(open[3])}`);
      return;
    }
    out.push(line
      .replace(/<img\b[^>]*>/gi, (tag) => imgTagToMarkdown(tag))
      .replace(/<span\b([^>]*?)\bstyle\s*=\s*"([^"]*)"([^>]*)>/gi, (whole, before, style, after) => {
        const kept = styleWithoutSizes(style);
        return kept ? `<span${before}style="${kept}"${after}>` : `<span${before}${after}>`.replace(/\s+>/, ">");
      }));
  });
  return out.join("\n");
}

// ── What kind of thing it is ──────────────────────────────────────────────
//
// A Block's width on the Canvas is set by its kind: words by the measure (◐
// Canvas → Widest a Block grows), a picture by "Pictures land at", a table or
// a listing by "Tables and code land at". A Block that is ONLY a picture
// (with at most a caption line) is a picture; one with a fence is code or a
// diagram; one with a table's delimiter row is a table; the rest is words.

const IMAGE_MD_RE = /!\[[^\]]*\]\((?:<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/m;

export function canvasItemKind(md) {
  const text = String(md ?? "").trim();
  if (!text) return "text";
  const fence = text.match(/^\s*(?:```|~~~)\s*([\w-]*)/m);
  if (fence) {
    const lang = fence[1].toLowerCase();
    return lang === "mermaid" || lang === "nomnoml" ? "diagram" : "code";
  }
  if (TABLE_DELIM_RE.test(text)) return "table";
  const images = text.match(IMAGE_MD_RE) || [];
  if (images.length) {
    const rest = text.replace(IMAGE_MD_RE, "").replace(/[\s*_]+/g, " ").trim();
    if (rest.length <= 80) return "picture";
  }
  return "text";
}

// ── Words with no markup ──────────────────────────────────────────────────

// Markdown that shows a PDF's words as they are — no emphasis, list or
// heading made by a star or a hash that happens to be in them.
export function escapePlainMarkdown(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_[\]<>|~])/g, "\\$1")
    .replace(/^(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/, "\\$1");
}

const BULLET_RE = /^\s*(?:[•●▪◦‣∙·\-*+–]|\(?\d{1,3}[.)])\s+/;
const URL_ONLY_RE = /^<?(https?:\/\/[^\s<>]+)>?$/i;

// Plain words — what a desktop PDF reader or another app drags — laid out as
// a PDF tab's own words are: a line broken only because the page was narrow
// joins the next (a hyphen at a line's end joins the word), a blank line still
// parts two paragraphs, and a bullet still starts its own line. Each paragraph
// is then escaped, so a stray star or hash stays a star or a hash. A link on
// its own is kept a link.
export function pdfPlainToMarkdown(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  const paragraphs = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) paragraphs.push(current);
    current = null;
  };
  lines.forEach((raw) => {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flush(); return; }
    const bullet = BULLET_RE.test(line);
    if (bullet || !current) {
      flush();
      current = { bullet, text: line.trim() };
      return;
    }
    if (/[A-Za-z]-$/.test(current.text) && /^[a-z]/.test(line.trim())) {
      current.text = current.text.slice(0, -1) + line.trim();
    } else {
      current.text += ` ${line.trim()}`;
    }
  });
  flush();
  return paragraphs.map(({ bullet, text: words }) => {
    const url = words.match(URL_ONLY_RE);
    if (url) return `<${url[1]}>`;
    if (bullet) return `- ${escapePlainMarkdown(words.replace(BULLET_RE, ""))}`;
    return escapePlainMarkdown(words);
  }).join("\n\n");
}
