// LaTeX-style section numbers on a note's headings — 1, 1.1, 1.2, 1.2.1 …
//
// ── Drawn, never written ────────────────────────────────────────────────────
//
// The number is not in the markdown. It is worked out from the note's headings
// every time they are scanned, and put on the rendered heading as
// data-heading-number, which styles/86-heading-numbers.css prints with
// ::before. So adding or moving a section renumbers everything after it, the
// way \section does, and the note's own text — what is synced, exported as
// Markdown, copied, searched and anchored on — never carries a number that
// could go stale.
//
// A pseudo-element rather than a span in the heading, deliberately: everything
// that pairs a rendered heading with its source (notesHeadingMatchesNode), maps
// a click to a raw offset, or quotes a heading as an anchor reads textContent,
// and a number the machine added must not change what a heading says. The one
// place the number does become text is an export (writeHeadingNumbersAsText),
// because a file that leaves the app has no stylesheet to draw it with.
//
// ── How a number is counted ─────────────────────────────────────────────────
//
// By NESTING, not by how many #s a heading has:
//
//   • the shallowest heading in the note is 1, 2, 3 — a note that starts at ##
//     is not 0.1, 0.2 (the contents drawer and paging make the same choice);
//   • a skipped level collapses — a ### straight under a # is 1.1, not LaTeX's
//     1.0.1;
//   • every level is numbered, down to 1.1.1.1.1.1.
//
// No imports, on purpose: tools/heading-numbers-check.mjs loads this module in
// plain Node.

// Levels (1–6) in document order → their numbers, in the same order.
//
// The stack holds the levels of the sections still open. A heading closes
// every open section at its own level or deeper, and its depth is how many are
// left open above it — which is what makes a skipped level collapse, and what
// copes with a note whose first heading is deeper than a later one (### then #
// is 1 then 2, not 0.0.1 then 1).
export function headingNumbersForLevels(levels) {
  const open = [];
  const counters = [];
  return (levels || []).map((level) => {
    while (open.length && open[open.length - 1] >= level) open.pop();
    const depth = open.length;
    open.push(level);
    counters.length = depth + 1;
    counters[depth] = (counters[depth] || 0) + 1;
    return counters.join(".");
  });
}

// ...and the parent of each, by the same nesting: the index of the nearest
// earlier heading that is still open above it, or -1 for a top-level one. The
// section filter (src/panels/highlight-sections.js) uses this to make picking
// "2 Methods" mean 2.1 and 2.2.3 as well.
export function headingParentsForLevels(levels) {
  const open = [];
  return (levels || []).map((level, index) => {
    while (open.length && open[open.length - 1].level >= level) open.pop();
    const parent = open.length ? open[open.length - 1].index : -1;
    open.push({ level, index });
    return parent;
  });
}

// The setting, as applyStyleSettings last left it. The stylesheet is gated on
// the class that sets alongside this, so the screen needs no re-render when it
// changes; this flag is for the places the number is TEXT — exports and the
// highlight lists' section labels.
let numbersOn = true;

export const HEADING_NUMBERS_CLASS = "heading-numbers";

export function headingNumbersOn() {
  return numbersOn;
}

export function setHeadingNumbersOn(on) {
  numbersOn = Boolean(on);
  if (typeof document !== "undefined") document.documentElement.classList.toggle(HEADING_NUMBERS_CLASS, numbersOn);
}

// "1.2 Methods" when numbers are on, "Methods" when they are off — the label a
// list prints for the section a highlight is in. A number the heading already
// had typed into it ("## 3.1 Methods", pasted from a PDF) goes when the drawn
// one comes, so the label never reads "1.2 3.1 Methods".
export function numberedHeadingLabel(heading) {
  if (!heading) return "";
  const title = heading.title || "";
  if (!numbersOn || !heading.number) return title;
  return `${heading.number} ${withoutTypedNumber(title, heading.typedNumber)}`;
}

// ── Numbers TYPED into a heading ────────────────────────────────────────────
//
// A heading pasted from a PDF, a web page or a book usually brings its own
// number — "1.2 Methods", "(a) Setup", "IV. Results", even "1. 1.1 Intro" when
// two numberings met — and with the drawn number in front of it the reader saw
// both, the typed one often stale. So while numbering is on, the typed marker
// is hidden wherever the drawn one is shown (span.heading-typed-number, which
// styles/86-heading-numbers.css takes out), and it is left out of headings that
// are pasted or imported (stripTypedHeadingNumbersFromMarkdown).
//
// Hidden, not removed, in a note that already has them: the note's text is the
// reader's, it is what [[Note#heading]] anchors were written against, and
// turning numbering off shows the typed numbers again.
//
// ── What counts as a typed number ───────────────────────────────────────────
//
// One or more markers at the very start of the title, each followed by a
// separator (space, or " - ", " – ", " — ", " | ", ": "):
//
//   1  1.2  1.2.3  2-1  2.3.b      arabic, with sub-parts
//   A.1  B.2.3                     a letter with sub-parts
//   ii  IV  XXXIX                  roman, up to 39
//   a  B                           a single letter — only as "a." "a)" "(a)"
//
// each optionally after "§" and/or inside ( ) or [ ], optionally ending "." ")"
// or ":". "1.Introduction" (the space lost in a copy) counts too.
//
// A marker is CERTAIN when it has punctuation (". ) :", brackets, "§", a dash
// separator), sub-parts ("1.2"), or another marker after it ("1 1.1"). A BARE
// one — "1 Introduction", "IV Results" — could just as well be the title
// ("10 Things", "II Results" is rare but "3 Tips" is not), so it is only taken
// when the note is visibly numbered: at least two headings carry a marker and
// they are at least half of the headings. Words are never a marker — "Chapter
// 3:", "Part II", "Appendix A" stay — nor is a bare single letter ("A Tale",
// "I Am"), nor anything that would leave the heading with no words at all.

export const HEADING_TYPED_NUMBER_CLASS = "heading-typed-number";

const ROMAN_UPPER = "(?=[IVX])X{0,3}(?:IX|IV|V?I{0,3})";
const ROMAN_LOWER = "(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})";
const SPACE = "[ \\t\\u00a0\\u2000-\\u200b\\u202f]";
// The label, with which kind it is: dotted (has sub-parts), int, roman, letter.
const LABEL = `(?<dotted>\\d{1,3}(?:[.\\-]\\d{1,3})+(?:\\.[a-z])?|[A-Za-z](?:\\.\\d{1,3})+)|(?<int>\\d{1,3})|(?<roman>${ROMAN_UPPER}|${ROMAN_LOWER})|(?<letter>[A-Za-z])`;
const MARKER_RE = new RegExp(
  `^(?<section>§{1,2}${SPACE}*)?(?:(?<open>[(\\[])${SPACE}*(?:${LABEL})${SPACE}*[)\\]](?<after>[.:])?|(?:${LABEL.replace(/\?<(\w+)>/g, "?<$1U>")})(?<term>[.):])?)` +
  `(?:(?<sep>${SPACE}*[-\\u2013\\u2014|:]${SPACE}+|${SPACE}+)|(?=\\p{Lu}))`,
  "u"
);
const WORDY = /[\p{L}\p{N}]/u;
const MAX_MARKERS = 3;

// The markers at the start of one title: { length, certain } for the run of
// them, `length` counted in the title's own characters, or null.
export function typedNumberMarkers(title) {
  const text = String(title || "");
  const lead = text.length - text.trimStart().length;
  let at = lead;
  const found = [];
  while (found.length < MAX_MARKERS) {
    const m = MARKER_RE.exec(text.slice(at));
    if (!m) break;
    const g = m.groups;
    const bracketed = Boolean(g.open);
    const kind = g.dotted || g.dottedU ? "dotted" : g.int || g.intU ? "int" : g.roman || g.romanU ? "roman" : "letter";
    const label = g.dotted || g.int || g.roman || g.letter || g.dottedU || g.intU || g.romanU || g.letterU || "";
    const term = bracketed ? (g.after || ")") : (g.term || "");
    // "1.Introduction", the space lost in a copy: only after "1." or "1.2." —
    // never "3D Printing" or "IVResults".
    if (!g.sep && !(g.term === "." && (kind === "dotted" || kind === "int"))) break;
    const punctuated = bracketed || Boolean(term) || Boolean(g.section) || /[-–—|:]/.test(g.sep || "");
    // A bare single letter is a word ("A Tale"), and so is a bare one-letter
    // roman numeral ("I Am", "X Factor", "V for Vendetta").
    if (!punctuated && (kind === "letter" || (kind === "roman" && label.length === 1))) break;
    const rest = text.slice(at + m[0].length);
    // "J. K. Rowling", "E. coli": a lone letter and a full stop is an initial
    // when a name or a lower-case word follows it.
    if (!bracketed && term === "." && (kind === "letter" || (kind === "roman" && label.length === 1))) {
      if (/^\p{Ll}/u.test(rest) || /^\p{L}\.\s/u.test(rest)) break;
    }
    found.push({ end: at + m[0].length, certain: punctuated || kind === "dotted" });
    at += m[0].length;
  }
  // Never the whole heading: give back markers until some words are left.
  while (found.length && !WORDY.test(text.slice(found[found.length - 1].end))) found.pop();
  if (!found.length) return null;
  const certain = found.length > 1 || found[0].certain;
  return { length: found[found.length - 1].end, certain, markers: found };
}

// For every title of a note, in order, the typed prefix to hide — the markers
// and the separator after them, exactly as the title spells them — or "".
// Over the whole note at once, because whether a bare "1 Introduction" is a
// number depends on its neighbours.
export function typedHeadingNumbers(titles) {
  const list = Array.from(titles || [], (t) => String(t || ""));
  const found = list.map(typedNumberMarkers);
  const carrying = found.filter(Boolean).length;
  const numbered = carrying >= 2 && carrying * 2 >= list.length;
  return list.map((title, i) => {
    const f = found[i];
    if (!f) return "";
    if (f.certain || numbered) return title.slice(0, f.length);
    return "";
  });
}

// The title with its typed prefix taken off — what a text label says.
export function withoutTypedNumber(title, typedNumber) {
  const text = String(title || "");
  if (!typedNumber || !text.startsWith(typedNumber)) return text;
  return text.slice(typedNumber.length);
}

// Non-whitespace characters in a prefix: how a prefix worked out on the
// source's text is found again in the rendered heading, whose whitespace may
// differ but whose other characters are the same ones (plainHeadingText exists
// to make them the same).
function solidLength(text) {
  return String(text || "").replace(/\s+/g, "").length;
}

// A label in a list or the contents: the title, with its typed prefix in a
// span the stylesheet hides while numbers are drawn.
export function fillHeadingTitle(node, title, typedNumber = "") {
  if (!node) return node;
  node.textContent = "";
  node.append(...headingTitleNodes(node.ownerDocument, title, typedNumber));
  return node;
}

// The same, as nodes to append after something else (a drawn number's span).
export function headingTitleNodes(doc, title, typedNumber = "") {
  const text = String(title || "");
  if (!typedNumber || !text.startsWith(typedNumber)) return [text];
  const span = doc.createElement("span");
  span.className = HEADING_TYPED_NUMBER_CLASS;
  span.textContent = typedNumber;
  return [span, text.slice(typedNumber.length)];
}

// Parts of a rendered heading that are the app's, not the heading's words.
const NOT_HEADING_TEXT = new Set(["notes-fold-twisty", "heading-number-mark", "heading-number", "hl-note-badge"]);

function isAppChrome(node) {
  if (node.nodeType !== 1) return false;
  for (const name of node.classList || []) if (NOT_HEADING_TEXT.has(name)) return true;
  return node.tagName === "BUTTON";
}

function unwrapTypedNumber(heading) {
  heading.querySelectorAll(`.${HEADING_TYPED_NUMBER_CLASS}`).forEach((span) => {
    const parent = span.parentNode;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    span.remove();
    parent.normalize();
  });
}

// On a rendered heading: put the first characters of its words — the typed
// prefix — in span.heading-typed-number, across whatever inline markup they are
// in (a <strong>, a highlight's <mark>). The heading's textContent does not
// change, so nothing that pairs it with its source, slugs it or maps a click in
// it to the raw text sees any difference.
export function markTypedHeadingNumber(heading, typedNumber) {
  if (!heading) return;
  const want = solidLength(typedNumber);
  const current = Array.from(heading.querySelectorAll(`.${HEADING_TYPED_NUMBER_CLASS}`));
  if (current.length && solidLength(current.map((s) => s.textContent).join("")) === want) return;
  if (current.length) unwrapTypedNumber(heading);
  if (!want) return;
  const texts = [];
  const collect = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) texts.push(child);
      else if (child.nodeType === 1 && !isAppChrome(child)) collect(child);
    }
  };
  collect(heading);
  const pieces = [];
  let left = want;
  for (const node of texts) {
    const s = node.nodeValue;
    let i = 0;
    while (i < s.length && left > 0) {
      if (!/\s/.test(s[i])) left -= 1;
      i += 1;
    }
    // ...and the separator after it, so the title does not start with a space.
    if (left === 0) while (i < s.length && /\s/.test(s[i])) i += 1;
    if (i > 0) pieces.push([node, i]);
    if (left === 0 && i < s.length) break;
  }
  if (left > 0) return; // the heading does not say what its source does
  const doc = heading.ownerDocument;
  for (const [node, count] of pieces) {
    if (count < node.nodeValue.length) node.splitText(count);
    const span = doc.createElement("span");
    span.className = HEADING_TYPED_NUMBER_CLASS;
    node.parentNode.insertBefore(span, node);
    span.appendChild(node);
  }
}

// ── Leaving typed numbers out of pasted and imported markdown ───────────────
//
// For content arriving from elsewhere — a rich-text paste, a web page, an EPUB
// — while numbering is on. The same markers as above, decided over the
// headings of what arrived, removed from the markdown itself. Tolerates what a
// converter puts in a heading: Turndown's escapes ("1\. Intro") and emphasis
// around the number ("**1.2** Intro", "**1.2 Intro**").

const MD_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const MD_ATX_RE = /^( {0,3}(?:> ?)*#{1,6}[ \t]+)(.*)$/;
const MD_SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const MD_PLAIN_START_RE = /^ {0,3}(?![-*+>#|]|\d+[.)][ \t]|`{3}|~{3})\S/;
const MD_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

// What a heading's markdown says as text — the same steps plainHeadingText
// (src/render/block-cache.js) takes, enough for the start of a heading.
function plainMarkdownHeading(raw) {
  return String(raw || "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])|(?:\*\*\*|___|\*\*|__|\*|~~)/g, (whole, escaped) => escaped ?? "")
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (whole, name) => MD_ENTITIES[name] ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

// Take `solid` non-whitespace TEXT characters off the front of a heading's
// markdown, and the whitespace after them. Markup in that stretch is not text:
// an escape's backslash goes with its character, and emphasis markers are kept
// unless they open and close within it ("**1.2** Intro" loses both; the "**"
// of "**1.2 Intro**" stays, still closed by its partner).
function dropMarkdownPrefix(raw, solid) {
  let i = 0;
  let left = solid;
  const markup = [];
  while (i < raw.length && left > 0) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length && /[\\`*_{}[\]()#+\-.!>~|]/.test(raw[i + 1])) {
      left -= 1;
      i += 2;
      continue;
    }
    const run = /^(?:\*{1,3}|_{1,3}|~~|`+)/.exec(raw.slice(i));
    if (run) {
      markup.push(run[0]);
      i += run[0].length;
      continue;
    }
    if (ch === "&") {
      const entity = /^&(?:#39|amp|lt|gt|quot|apos|nbsp);/.exec(raw.slice(i));
      if (entity) {
        left -= 1;
        i += entity[0].length;
        continue;
      }
    }
    if (!/\s/.test(ch)) left -= 1;
    i += 1;
  }
  if (left > 0) return raw;
  // A closing run straight after the prefix belongs to it.
  const closing = /^(?:\*{1,3}|_{1,3}|~~)/.exec(raw.slice(i));
  if (closing && markup.length && markup[markup.length - 1] === closing[0]) {
    markup.push(closing[0]);
    i += closing[0].length;
  }
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  // Pairs that opened and closed inside the prefix cancel out.
  const kept = [];
  for (const run of markup) {
    if (kept.length && kept[kept.length - 1] === run) kept.pop();
    else kept.push(run);
  }
  return kept.join("") + raw.slice(i);
}

export function stripTypedHeadingNumbersFromMarkdown(markdown) {
  const source = String(markdown ?? "");
  if (!/^ {0,3}(?:> ?)*#|\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/m.test(source)) return source;
  const lines = source.split("\n");
  const headings = []; // { line, head, body }
  let fence = null;
  let inComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = MD_FENCE_RE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    const startedInComment = inComment;
    let at = 0;
    for (;;) {
      const next = inComment ? line.indexOf("-->", at) : line.indexOf("<!--", at);
      if (next === -1) break;
      at = next + (inComment ? 3 : 4);
      inComment = !inComment;
    }
    if (startedInComment || inComment) continue;
    const atx = MD_ATX_RE.exec(line);
    if (atx) {
      const body = atx[2].replace(/(?:^|[ \t])#+[ \t]*$/, "");
      headings.push({ line: i, head: atx[1], body, tail: atx[2].slice(body.length) });
      continue;
    }
    // A one-line paragraph underlined with === or --- is a heading too.
    const prevBlank = i === 0 || lines[i - 1].trim() === "";
    if (prevBlank && i + 1 < lines.length && MD_SETEXT_RE.test(lines[i + 1]) && MD_PLAIN_START_RE.test(line)) {
      const lead = /^ */.exec(line)[0];
      headings.push({ line: i, head: lead, body: line.slice(lead.length), tail: "" });
      i += 1;
    }
  }
  if (!headings.length) return source;
  const plains = headings.map((h) => plainMarkdownHeading(h.body));
  const prefixes = typedHeadingNumbers(plains);
  let changed = false;
  headings.forEach((h, k) => {
    if (!prefixes[k]) return;
    const body = dropMarkdownPrefix(h.body, solidLength(prefixes[k]));
    if (body === h.body || !plainMarkdownHeading(body)) return;
    lines[h.line] = h.head + body + h.tail;
    changed = true;
  });
  return changed ? lines.join("\n") : source;
}

// The headings of a container that is rendered whole, the way the notes view
// chooses them (bindNotesHeadingElements): an empty heading is not a section,
// and a heading inside a list item is not in the contents.
//
// `until`, when given, ends the list at the first heading it accepts — an
// export's "Highlight Notes" appendix is the app's, not a section of the note,
// and is left unnumbered.
export function sectionHeadingsIn(container, until = null) {
  if (!container?.querySelectorAll) return [];
  const nodes = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .filter((h) => h.textContent.trim() !== "")
    .filter((h) => !h.closest("li"));
  if (!until) return nodes;
  const stop = nodes.findIndex((h) => until(h));
  return stop === -1 ? nodes : nodes.slice(0, stop);
}

// For the surfaces that render a whole piece of markdown at once — a Quick Note
// card, an EPUB chapter preview, an export root before its numbers are written.
// The notes view does not come through here: most of a long note is not in the
// DOM, so its numbers come from the source scan instead (see
// notesHeadingsForPrepared in src/notes/toc.js).
export function numberRenderedHeadings(container, until = null) {
  const nodes = sectionHeadingsIn(container, until);
  const numbers = headingNumbersForLevels(nodes.map((h) => Number(h.tagName[1])));
  const typed = typedHeadingNumbers(nodes.map(headingWords));
  nodes.forEach((h, i) => {
    h.dataset.headingNumber = numbers[i];
    markTypedHeadingNumber(h, typed[i]);
  });
  return nodes.length;
}

// What a rendered heading says, without the app's own parts of it.
function headingWords(heading) {
  let text = "";
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) text += child.nodeValue;
      else if (child.nodeType === 1 && !isAppChrome(child)) walk(child);
    }
  };
  walk(heading);
  return text.replace(/\s+/g, " ").trim();
}

function mayHoldHeadings(html) {
  return typeof document !== "undefined" && /<h[1-6][\s>]/i.test(String(html || ""));
}

// numberRenderedHeadings for markup that is still a string — a Quick Notes
// card is built as one.
export function numberHeadingsInHtml(html) {
  if (!mayHoldHeadings(html)) return html;
  const holder = document.createElement("template");
  holder.innerHTML = html;
  return numberRenderedHeadings(holder.content) ? holder.innerHTML : html;
}

// ── Where the number sits on a heading in the notes view ────────────────────
//
// A note's heading starts with its fold arrow (the twisty block-cache.js
// prepends), and a ::before on the heading would come ahead of it — "1 ▾
// Introduction", the number cut off from its title by a button. So in the notes
// view the number is drawn by an EMPTY span placed after the arrow: still no
// text in the heading (the number is the span's ::before), so nothing that reads
// what a heading says sees it, and the order reads "▾ 1 Introduction". The
// arrow is prepended, so one that arrives after the span still lands in front.
export const HEADING_NUMBER_MARK_CLASS = "heading-number-mark";

// ...and on the heading, a class saying it carries one, so the stylesheet can
// leave its own ::before off without asking with :has(> .heading-number-mark).
// A :has() on an element inside the note is the shape b4394ea took out of the
// stylesheets: the browser re-checks it as the note's DOM changes under it.
export const HEADING_HAS_MARK_CLASS = "has-number-mark";

const FOLD_TWISTY_SELECTOR = ":scope > .notes-fold-twisty";

// `typedNumber` is the number already typed at the start of the heading, if
// any (typedHeadingNumbers), hidden while the drawn one shows. Left out, the
// heading's typed number is left as it is.
export function setHeadingNumberMark(heading, number, typedNumber) {
  if (!heading) return;
  heading.dataset.headingNumber = number || "";
  if (typedNumber !== undefined) markTypedHeadingNumber(heading, number ? typedNumber : "");
  let mark = heading.querySelector(`:scope > .${HEADING_NUMBER_MARK_CLASS}`);
  if (!number) {
    mark?.remove();
    heading.classList.remove(HEADING_HAS_MARK_CLASS);
    return;
  }
  if (!mark) {
    mark = document.createElement("span");
    mark.className = HEADING_NUMBER_MARK_CLASS;
    mark.setAttribute("aria-hidden", "true");
    const twisty = heading.querySelector(FOLD_TWISTY_SELECTOR);
    if (twisty) twisty.after(mark);
    else heading.prepend(mark);
  }
  mark.dataset.headingNumber = number;
  heading.classList.add(HEADING_HAS_MARK_CLASS);
}

export const HEADING_NUMBER_TEXT_CLASS = "heading-number";

// An export's numbers, as text. The print root, the standalone HTML and the
// .docx writer (inlineRunsForNode) all read the DOM, and none of them has
// styles/86-heading-numbers.css to draw a ::before with — so the number goes in
// as a real span, once, followed by a space.
//
// Works on an HTML string too, which is what most of the export builders pass
// around; anything else is returned untouched.
export function writeHeadingNumbersAsText(target, { until = null } = {}) {
  if (!numbersOn) return target;
  if (typeof target === "string") {
    if (!mayHoldHeadings(target)) return target;
    // A <template>, not a <div>: its content is inert, so an image in the note
    // is not fetched just because the markup was parsed here.
    const holder = document.createElement("template");
    holder.innerHTML = target;
    writeHeadingNumbersAsText(holder.content, { until });
    return holder.innerHTML;
  }
  numberRenderedHeadings(target, until);
  sectionHeadingsIn(target, until).forEach((h) => {
    if (h.querySelector(`:scope > .${HEADING_NUMBER_TEXT_CLASS}`)) return;
    // The typed number the drawn one replaces: hidden on screen by the
    // stylesheet, which a file that leaves the app does not have — so it goes.
    h.querySelectorAll(`.${HEADING_TYPED_NUMBER_CLASS}`).forEach((span) => span.remove());
    const span = document.createElement("span");
    span.className = HEADING_NUMBER_TEXT_CLASS;
    span.textContent = h.dataset.headingNumber;
    h.prepend(span, document.createTextNode(" "));
    // Written, so it must not ALSO be drawn by a stylesheet that happens to be
    // present (the print root is inside the app's own document).
    delete h.dataset.headingNumber;
  });
  return target;
}

// The heading notesForExport writes in front of a note's highlight notes (see
// src/export/notes-body.js) — where an export's numbering stops.
export function isHighlightNotesAppendixHeading(h) {
  return h?.tagName === "H2" && h.textContent.trim() === "Highlight Notes";
}
