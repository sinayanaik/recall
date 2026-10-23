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
// list prints for the section a highlight is in.
export function numberedHeadingLabel(heading) {
  if (!heading) return "";
  const title = heading.title || "";
  return numbersOn && heading.number ? `${heading.number} ${title}` : title;
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
  nodes.forEach((h, i) => { h.dataset.headingNumber = numbers[i]; });
  return nodes.length;
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

export function setHeadingNumberMark(heading, number) {
  if (!heading) return;
  heading.dataset.headingNumber = number || "";
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
