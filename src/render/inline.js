// Inline markup the renderer must not touch: code spans, images, citations.

import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { applyClozeMarkup } from "./cloze-markup.js?v=__BUILD__";
import { protectMath } from "./math.js?v=__BUILD__";
import { applyNoteLinkMarkup } from "./note-links.js?v=__BUILD__";

// Apply the inline transforms (cloze, then math) that run on non-fenced text.
// Inline code spans (`code`, or ``code`` etc. so a literal backtick can appear
// inside — CommonMark closes on a run of exactly the same length as the
// opener) must be skipped, the same way preprocessSpecialBlocks already skips
// ``` fences — otherwise typing `{{x}}` or `$x$` as literal documentation
// (e.g. showing Mustache/Jinja2 syntax, or LaTeX syntax itself) turns it into
// a live cloze/math widget instead of staying inline code. Triple-backtick
// FENCES never reach here at all (already sliced out by preprocessSpecialBlocks).
//
// Cloze and code-span detection can't just run as two independent passes
// (cloze-then-code or code-then-cloze) — whichever delimiter the text writer
// meant to open FIRST has to win: "{{`SELECT`}}" clozes a code term (cloze
// opens first, its content includes an ordinary code span, which still
// becomes <code> once marked.parse() sees it — cloze's own regex is left
// alone, it doesn't need to know about code), while "`{{x}}`" documents
// literal cloze syntax as code (backtick opens first, content stays fully
// literal). This scans left-to-right and lets whichever token starts earlier
// consume its full span before continuing.
export function protectInline(segment) {
  let output = "";
  let i = 0;
  const len = segment.length;

  while (i < len) {
    const clozeStart = segment.indexOf("{{", i);
    // indexOf, never segment.slice(i) + regex. Slicing copied the WHOLE
    // remaining document on every iteration and then scanned that copy, so a
    // note with k code spans cost O(n·k) — measured quadratic (200KB → 5ms,
    // 1MB → 64ms, 2MB → 250ms), paid on every render that isn't a cache hit.
    // codeRegionEnd and findUnescaped already solve this exact problem the
    // cheap way; this is the same approach.
    const codeStart = segment.indexOf("`", i);

    if (codeStart !== -1 && (clozeStart === -1 || codeStart < clozeStart)) {
      let ticks = 0;
      while (segment[codeStart + ticks] === "`") ticks += 1;
      const afterOpen = codeStart + ticks;
      // CommonMark closes an inline span on a backtick run of EXACTLY this
      // length, so skip over any longer run rather than matching inside it.
      let closeAt = -1;
      const fence = "`".repeat(ticks);
      for (let at = segment.indexOf(fence, afterOpen); at !== -1; at = segment.indexOf(fence, at + 1)) {
        if (segment[at + ticks] === "`") continue; // part of a longer run
        closeAt = at;
        break;
      }
      if (closeAt !== -1) {
        const codeEnd = closeAt + ticks;
        output += protectMath(applyClozeMarkup(applyNoteLinkMarkup(segment.slice(i, codeStart))));
        output += segment.slice(codeStart, codeEnd); // raw code span, untouched
        i = codeEnd;
        continue;
      }
      // Backtick run with no matching close — not a real code span. Fall
      // through to check for a cloze at/after this position instead.
    }

    if (clozeStart !== -1) {
      const closeIdx = segment.indexOf("}}", clozeStart + 2);
      if (closeIdx !== -1) {
        output += protectMath(applyClozeMarkup(applyNoteLinkMarkup(segment.slice(i, clozeStart))));
        const inner = segment.slice(clozeStart + 2, closeIdx);
        output += `<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">${protectMath(inner)}</span>`;
        i = closeIdx + 2;
        continue;
      }
    }

    // Neither a valid code span nor a valid cloze from here on — process
    // whatever's left as plain text (any stray "`"/"{{" survive literally,
    // same as CommonMark treats an unmatched backtick) and stop.
    output += protectMath(applyClozeMarkup(applyNoteLinkMarkup(segment.slice(i))));
    break;
  }

  return output;
}

// Raw-markdown convenience for side-by-side images: a line that is two or more
// images separated by "|" renders as one row, e.g.
//   ![](a.png) | ![](b.png) | ![](c.png)
// Each image may be markdown `![alt](url)` or a raw `<img>` tag. The whole line
// must be images + "|" separators (anything else, or a single image, is left
// alone), which also keeps GFM table rows — those start with a leading "|" —
// untouched. The line becomes a `<div class="notes-img-row">` block, the same
// wrapper the resize grips understand, so each image stays individually
// resizable.

// ── What one image is written as ───────────────────────────────────────────
//
// The alt text and the destination are matched as BALANCED runs rather than as
// "everything up to the first ] or )". `[^)]*` stopped a URL at its first
// closing paren, so `![](…/Foo_(bar).png)` was read as `…/Foo_(bar` — a URL
// that matches no rendered image, so the picture lost its resize grip and its
// delete button, and a source slice that ends mid-URL, so committing a width
// would have spliced into the middle of one. `[^\]]*` did the same to alt text
// holding a bracket (a clipped `![see [1]](…)`), which was not found at all.
// Both shapes are ordinary in pasted, clipped and imported notes.
//
// One level of nesting, which is what marked itself resolves. Anything deeper
// fails to match rather than matching wrongly, so the worst case stays "this
// image has no controls" and never becomes "a control that rewrites the wrong
// text".
//
// ── ...and neither run may cross a BLANK line ─────────────────────────────
//
// A blank line ends the paragraph, so nothing after one can be part of the same
// image — marked will not read it as one and neither may this. Unbounded, the
// balanced runs above ran until they found their closing bracket wherever it
// was, and a stray `![](` in a note swallowed everything down to the next `)`:
//
//     ![a](one.png          scanned as ONE image whose "URL" is
//                           `one.png\n\ntext\n\n![b](two.png)\n\nmore`
//     text
//                           …so deleting it took the paragraph AND the second
//     ![b](two.png)         picture with it, and marked had rendered neither
//                           of them as that image in the first place.
//     more)
//
// A SINGLE newline stays legal: a soft break inside alt text is ordinary.
export const INLINE_SOFT_BREAK_SOURCE = "\\n(?![^\\S\\n]*\\n)";

export const IMG_ALT_SOURCE =
  `\\[(?:[^\\[\\]\\\\\\n]|\\\\.|${INLINE_SOFT_BREAK_SOURCE}`
  + `|\\[(?:[^\\[\\]\\\\\\n]|\\\\.|${INLINE_SOFT_BREAK_SOURCE})*\\])*\\]`;

export const IMG_DEST_SOURCE =
  `\\((?:[^()\\\\\\n]|\\\\.|${INLINE_SOFT_BREAK_SOURCE}`
  + `|\\((?:[^()\\\\\\n]|\\\\.|${INLINE_SOFT_BREAK_SOURCE})*\\))*\\)`;

// ── The tag branch stops at the tag ───────────────────────────────────────
//
// `<img\b[^>]*>` was the same mistake in its plainest form: `[^>]` matches a
// newline, so an `<img` with no closing bracket — a truncated paste, imported
// HTML, a hand-typed tag — ran to the next `>` ANYWHERE in the note. Measured
// on a note holding one such tag, two pictures and a paragraph: one press of
// that image's delete button removed all three and half the prose, and a
// resize would have done the same.
//
// So: no newlines, and a quoted attribute value is consumed whole, which is
// also what makes `alt="1 > 2"` end where the tag ends rather than inside its
// own attribute (the slice used to stop at that first `>`, leaving ` 2">`
// behind in the note as visible text).
export const IMG_TAG_SOURCE = `<img\\b(?:"[^"\\n]*"|'[^'\\n]*'|[^>'"\\n])*>`;

export const IMG_TOKEN_SOURCE = `!${IMG_ALT_SOURCE}${IMG_DEST_SOURCE}|${IMG_TAG_SOURCE}`;

// The URL out of an image destination's inner text — everything between the
// parentheses, which may be `<bracketed>` and may carry a "title" after it.
// One definition, shared by the renderer's pipe-row path and by the control
// layer's parseMarkdownImage, because the two disagreeing about where a URL
// ends is how a grip comes to point at something the reader cannot see.
export function imageDestinationUrl(inner) {
  const text = String(inner || "").trim();
  const bracketed = text.match(/^<([^>]*)>/);
  if (bracketed) return bracketed[1].trim();
  return (text.split(/\s+(?=["'(])/)[0] ?? "").trim();
}

// ── ...unless the row belongs to a TABLE ──────────────────────────────────
//
// GFM lets a table be written without leading pipes, and a body row of one is
// then indistinguishable from a side-by-side image row when every cell holds a
// picture:
//
//     Before      After          <- header
//     --- | ---                  <- delimiter
//     ![a](1.png) | ![b](2.png)  <- a table row, and also a "pipe row"
//
// Turning that line into a .notes-img-row took the table apart: marked saw a
// header and a delimiter with no body under them, and the reader lost the
// table entirely. The line alone cannot tell the two apart — what decides it is
// the DELIMITER row above — so the test takes the text around the line.
//
// Exported because the delete has to agree: imageRemovalRange takes the "|"
// beside an image when the line is a side-by-side row, and taking one out of a
// table row would leave the table a column short. One predicate, both callers.
export const TABLE_DELIMITER_RE = /^[^\S\n]*:?-+:?([^\S\n]*\|[^\S\n]*:?-+:?)+[^\S\n]*$/;

export function pipeRowInTable(text, lineStart) {
  // Walk back over the rows above this one — a table body can be any height,
  // and every row above is either another candidate row or the delimiter.
  let at = lineStart;
  while (at > 0) {
    const previousEnd = at - 1;
    const previousStart = text.lastIndexOf("\n", previousEnd - 1) + 1;
    const previous = text.slice(previousStart, previousEnd);
    if (TABLE_DELIMITER_RE.test(previous)) return true;
    // Not a delimiter and not a row that could be sitting between this line and
    // one: nothing above can make this a table row.
    if (!previous.includes("|")) return false;
    at = previousStart;
  }
  return false;
}

export function renderImageRows(segment) {
  const lineRe = new RegExp(
    `^[^\\S\\n]*(?:${IMG_TOKEN_SOURCE})(?:[^\\S\\n]*\\|[^\\S\\n]*(?:${IMG_TOKEN_SOURCE}))+[^\\S\\n]*$`,
    "gm"
  );
  const imgRe = new RegExp(IMG_TOKEN_SOURCE, "gi");
  return segment.replace(lineRe, (line, offset) => {
    if (pipeRowInTable(segment, offset)) return line;
    const imgs = (line.match(imgRe) || []).map(imageMarkupToTag).filter(Boolean);
    if (imgs.length < 2) return line;
    return `<div class="notes-img-row">${imgs.join("")}</div>`;
  });
}

// Normalizes a single image token (markdown or raw <img>) to an <img> tag.
export function imageMarkupToTag(token) {
  const raw = token.trim();
  const md = raw.match(new RegExp(`^!(${IMG_ALT_SOURCE})(${IMG_DEST_SOURCE})$`));
  if (md) {
    // The title is dropped, the same way a resize commit drops it: a raw <img>
    // has nowhere to carry one. It used to be kept as part of the src, so
    // `![a](b.png "c")` in a side-by-side row rendered as a broken image.
    const url = imageDestinationUrl(md[2].slice(1, -1));
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(md[1].slice(1, -1))}">`;
  }
  if (/^<img\b[^>]*>$/i.test(raw)) return raw;
  return "";
}

// Citation / footnote markers render as noise in notes that were clipped or
// pasted from the web. Turndown escapes every "[" → "\[" and turns same-page
// reference anchors into links, so a footnote marker arrives as `[\[1\]](#fn1)`
// (backslash litter + a dead #fn1 link); plain reference brackets arrive as
// `\[1\]`, and footnote lists trail a back-reference arrow (↩). The clipper now
// fixes this at capture time, but notes captured earlier — or pasted from
// elsewhere — still carry it, so the renderer normalises the same shapes to a
// clean inline `[1]`. Deliberately narrow (numeric citation shapes, footnote
// hrefs only) so real escaped brackets, exponents, and ordinary links survive.
export const CITE_INNER = "\\d+[a-z]?(?:\\s*[-\\u2013\\u2014,;]\\s*\\d+[a-z]?)*";

export const CITE_HREF_FRAG = "#(?:fn|fnref|cite|ref|reference|footnote|note|endnote|_?ftn)";

export const CITATION_LINK_RE = new RegExp(
  "\\[\\s*\\\\?\\[?\\s*(" + CITE_INNER + ")\\s*\\\\?\\]?\\s*\\]\\(" + CITE_HREF_FRAG + "[^)]*\\)",
  "gi"
);

export const CITATION_ESCAPED_RE = new RegExp("\\\\\\[(\\s*" + CITE_INNER + "\\s*)\\\\\\]", "gi");

export const FOOTNOTE_BACKREF_LINK_RE = /\[[↩↵⮐︎\s]*\]\(#[^)]*\)/g;

export const FOOTNOTE_BACKREF_ARROW_RE = /[↩↵⮐]︎?/g;

export function normalizeCitations(text) {
  return String(text)
    // `[\[1\]](#fn1)` / `[1](#fn12)` → `[1]`, dropping the dead footnote anchor.
    .replace(CITATION_LINK_RE, "[$1]")
    // Bare escaped reference brackets: `\[1\]`, `\[1, 2\]`, `\[3-5\]` → `[1]` …
    .replace(CITATION_ESCAPED_RE, "[$1]")
    // Back-reference affordances left over from footnote lists.
    .replace(FOOTNOTE_BACKREF_LINK_RE, "")
    .replace(FOOTNOTE_BACKREF_ARROW_RE, "");
}
