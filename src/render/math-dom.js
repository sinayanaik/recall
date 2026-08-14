// Protecting already-rendered math in a DOM tree, for the paste path.
//
// Ported into the clipper (recall-clipper/content/recall-math.js), so
// tools/port-sync.mjs compares it — keep the formatting.
//
// The math must be extracted BEFORE any hidden-element stripping: MathJax
// keeps its source in a hidden node, and stripping first throws the formula
// away and leaves only the rendered glyphs.

import { findMathRanges } from "./math.js?v=__BUILD__";

// Turndown escapes Markdown punctuation in every text node it converts, which
// is fatal inside LaTeX: "x_k" comes out "x\_k" (KaTeX then prints a literal
// underscore) and "\int"/"\frac" come out "\\int"/"\\frac", which KaTeX reads
// as a line break followed by the words "int"/"frac". Pages that ship math as
// plain "$…$" text rather than rendered KaTeX/MathJax — AI transcripts, paper
// readers, raw README views — hit this on every paste.
//
// Escaping cannot be fixed one text node at a time, because a display block
// written as "$$<br>…<br>$$" (or with each line in its own <p>) puts the
// delimiters and the body in SEPARATE text nodes: escaping the body on its own
// cannot see that it is math at all. So the spans are found before Turndown
// runs, across the fragment's whole flattened text, and lifted into placeholder
// elements that convert back to their exact source text.
//
// Marks such a placeholder. Read back by the "raw-math" Turndown rule.
export const RAW_MATH_ATTR = "data-recall-raw-math";

// Stands in for an opaque subtree in the flat text: a character no pasted
// document contains, so it can never be mistaken for part of a formula.
export const MATH_OPAQUE_MARK = "\u0000";

// Subtrees the math scan must not look inside: their text is either code (where
// "$" is not a delimiter) or math that already has its own Turndown rule.
export const MATH_OPAQUE_SELECTOR =
  "code, pre, script, style, math, .katex, .MathJax, .MathJax_Preview, .MathJax_Display, mjx-container";

// Elements Turndown renders as their own block — the boundary between two of
// them is a line break in the markdown, so it has to be one in the flat text.
export const MATH_BLOCK_LEVEL = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

// Flattens `root`'s text the way Turndown will end up reading it — <br> and
// block edges become newlines, opaque subtrees become a single character that
// can never open a delimiter — while recording which node backs each offset,
// so a span found in the flat string can be cut back out of the DOM.
export function flattenTextForMath(root) {
  const segments = [];
  let flat = "";

  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const start = flat.length;
        flat += child.nodeValue;
        segments.push({ kind: "text", node: child, start, end: flat.length });
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      if (child.nodeName === "BR") {
        const start = flat.length;
        flat += "\n";
        segments.push({ kind: "break", node: child, start, end: flat.length });
        continue;
      }
      if (child.matches && child.matches(MATH_OPAQUE_SELECTOR)) {
        flat += MATH_OPAQUE_MARK;
        continue;
      }

      const isBlock = MATH_BLOCK_LEVEL.test(child.nodeName);
      if (isBlock && flat && !flat.endsWith("\n")) flat += "\n";
      walk(child);
      if (isBlock && flat && !flat.endsWith("\n")) flat += "\n";
    }
  };

  walk(root);
  return { flat, segments };
}

// Replaces every LaTeX span under `root` with a single placeholder element
// carrying its exact source text. See the note in htmlToMarkdown for why this
// has to happen before Turndown rather than inside its escape step.
export function protectMathInDom(root) {
  const { flat, segments } = flattenTextForMath(root);

  const ranges = findMathRanges(flat).filter(([start, end]) => {
    const tex = flat.slice(start, end);
    // An opaque subtree fell inside the span, so the text is not what the
    // markdown will say — leave it to the rules that own those nodes.
    if (tex.includes(MATH_OPAQUE_MARK)) return false;
    // Inline "$…$" is never multi-line. Without this, two dollar AMOUNTS in
    // different paragraphs ("costs $5" … "or $7 each") would swallow every
    // line between them.
    return !(tex.startsWith("$") && !tex.startsWith("$$") && tex.includes("\n"));
  });

  // Back to front: cutting a later span can't shift the offsets of an earlier one.
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const [start, end] = ranges[i];
    const covered = segments.filter((segment) => segment.start < end && segment.end > start);
    if (!covered.length) continue;

    const tex = flat.slice(start, end);
    const placeholder = document.createElement("span");
    placeholder.setAttribute(RAW_MATH_ATTR, tex);
    // Also the placeholder's text, for two reasons: Turndown deletes any node
    // whose textContent is blank BEFORE consulting the rules, so an empty span
    // would vanish; and if the rule ever stops matching, the fallback is the
    // formula rather than a hole where it used to be.
    placeholder.textContent = tex;

    covered.forEach((segment, index) => {
      if (segment.kind === "break") {
        if (index === 0) segment.node.parentNode.insertBefore(placeholder, segment.node);
        segment.node.remove();
        return;
      }
      const node = segment.node;
      const value = node.nodeValue;
      const from = Math.max(start, segment.start) - segment.start;
      const to = Math.min(end, segment.end) - segment.start;
      if (index === 0) {
        const parent = node.parentNode;
        const next = node.nextSibling;
        node.nodeValue = value.slice(0, from);
        parent.insertBefore(placeholder, next);
        const suffix = value.slice(to);
        if (suffix) parent.insertBefore(document.createTextNode(suffix), next);
        return;
      }
      node.nodeValue = value.slice(0, from) + value.slice(to);
    });
  }

  return root;
}

// Turndown escapes every literal "[" and "]" in prose so a bracket can never
// be re-read as link syntax. That is one bracket too many for us: "\[…\]" is
// also KaTeX's display-math delimiter, so pasted prose like "[citation needed]"
// or "[Figure 1]" came out escaped and then RENDERED AS MATH.
//
// Only one shape actually needs the escape — a bracket pair immediately
// followed by "(", which is what would turn back into a link the source never
// had. Everything else is relaxed to a bare bracket: it renders as itself,
// keeps the raw markdown readable, and carries no "\[" for protectMath to trip
// over. The one shape that stays escaped is handled on the other side —
// protectMath declines "\[…\](", see its comment. (Reference syntax,
// "[foo][ref]", needs a "[ref]:" definition that a pasted fragment never
// carries, so it is left bare like any other prose bracket.)
//
// Relaxing is deliberately unconditional rather than limited to balanced pairs:
// protectMathInDom cuts formulas out of their text node, so "[see $x$]" reaches
// this function as two separate calls with one bracket each. Leaving those
// escaped would hand protectMath a "\[…\]" straddling the formula and turn the
// whole phrase into math — the exact bug this is here to kill. The cost is that
// link text containing an unbalanced "]" is no longer protected, which Turndown
// only ever guarded heuristically anyway.
export function relaxEscapedBrackets(text) {
  const marks = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\") continue;
    const next = text[index + 1];
    if (next === "[" || next === "]") marks.push({ index, kind: next });
    // Whatever followed the backslash was consumed by it, so it can never be
    // an escape itself — this is what keeps "\\\[" (a literal backslash before
    // an escaped bracket) from being misread.
    index += 1;
  }
  if (!marks.length) return text;

  const keep = new Set();
  const open = [];
  marks.forEach((mark) => {
    if (mark.kind === "[") {
      open.push(mark);
      return;
    }
    const start = open.pop();
    if (!start) return;
    if (text[mark.index + 2] === "(") {
      keep.add(start.index);
      keep.add(mark.index);
    }
  });

  const drop = new Set(marks.map((mark) => mark.index).filter((index) => !keep.has(index)));
  if (!drop.size) return text;

  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    if (!drop.has(index)) output += text[index];
  }
  return output;
}
