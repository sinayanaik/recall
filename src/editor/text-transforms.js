// Pure string transforms on the raw editor's text: bold, code, fences, lists,
// inline styles. No DOM, no state — which is what makes them testable and what
// keeps the toolbar handler readable.

// Formatting helpers
// Toggles a marker pair around the current selection. A naive check of just
// the selected substring's own edges breaks two ways: (1) if the user
// double-clicks to reselect only the word inside an already-wrapped run
// (double-click stops at the marker's punctuation), the markers sit just
// OUTSIDE the new selection and get missed, so toggling re-wraps instead of
// un-wrapping (**hello** -> ****hello****); (2) a selection spanning multiple
// independently-wrapped runs (e.g. "**a** **b**") coincidentally starts/ends
// with the wrapper too, so a naive strip chops off the wrong characters and
// produces unbalanced markup. This checks the characters just outside the
// selection first (unambiguous), then falls back to stripping the selection's
// own edges only when doing so is unambiguous (no marker recurs inside),
// otherwise it just wraps — non-destructive nesting instead of corrupting text.
export function toggleWrapPair(val, start, end, open, close = open) {
  const before = val.slice(Math.max(0, start - open.length), start);
  const after = val.slice(end, end + close.length);
  if (before === open && after === close) {
    return { text: val.slice(start, end), rangeStart: start - open.length, rangeEnd: end + close.length };
  }

  const selected = val.slice(start, end);
  if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
    const inner = selected.slice(open.length, selected.length - close.length);
    if (!inner.includes(open) && !inner.includes(close)) {
      return { text: inner, rangeStart: start, rangeEnd: end };
    }
  }

  return { text: open + selected + close, rangeStart: start, rangeEnd: end };
}

export function toggleWrap(val, start, end, wrapper) {
  return toggleWrapPair(val, start, end, wrapper, wrapper);
}

export function toggleUnderline(val, start, end) {
  return toggleWrapPair(val, start, end, "<u>", "</u>");
}

export function toggleStrikethrough(val, start, end) {
  return toggleWrapPair(val, start, end, "~~", "~~");
}

// Inline code can't contain a literal newline in Markdown, so a multi-line
// selection needs a fenced ``` block instead of backticks — everything else
// (single line, or no selection) keeps the lighter-weight ` ` wrap.
export function toggleCode(val, start, end) {
  const selected = val.slice(start, end);
  return selected.includes("\n") ? toggleFence(val, start, end) : toggleWrapPair(val, start, end, "`", "`");
}

// Wrap/unwrap a multi-line selection in a fenced code block, mirroring
// toggleWrapPair's toggle behavior (wrap plain text, or strip an existing
// wrap back to plain text) but for ``` fences.
export function toggleFence(val, start, end) {
  const selected = val.slice(start, end);

  // Selection is a complete fenced block ("```lang\n...\n```") -> unwrap.
  const selfFenced = selected.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (selfFenced) {
    return { text: selfFenced[1], rangeStart: start, rangeEnd: end };
  }

  // Selection is just the inner lines, with the fence markers sitting just
  // outside it (what re-selecting the toggled-in text looks like) -> unwrap
  // by growing the replaced range to swallow those markers too.
  const beforeFence = val.slice(0, start).match(/```[^\n]*\n$/);
  const afterFence = val.slice(end).match(/^\n```/);
  if (beforeFence && afterFence) {
    return { text: selected, rangeStart: start - beforeFence[0].length, rangeEnd: end + afterFence[0].length };
  }

  // Otherwise wrap, only adding the surrounding newlines the text doesn't
  // already have so the fence doesn't create a stray blank line.
  const leadNl = start > 0 && val[start - 1] !== "\n" ? "\n" : "";
  const trailNl = end < val.length && val[end] !== "\n" ? "\n" : "";
  return { text: `${leadNl}\`\`\`\n${selected}\n\`\`\`${trailNl}`, rangeStart: start, rangeEnd: end };
}

export function toggleKbd(val, start, end) {
  return toggleWrapPair(val, start, end, "<kbd>", "</kbd>");
}

export function toggleCloze(val, start, end) {
  return toggleWrapPair(val, start, end, "{{", "}}");
}

// Strips opening/closing tags individually rather than pair-matching them
// with a lazy [\s\S]*? capture — pair-matching mishandles nesting (e.g. two
// nested <span style> wrappers: the lazy match consumes the outer open tag
// through the FIRST </span> it finds, which is the inner one, so the outer
// </span> is left behind unmatched and the inner span survives disguised as
// the only one). Stripping tags individually is correct at any nesting depth
// and needs no pairing at all. Used by the explicit "Clear formatting"
// action — per-property toolbar actions (font/color/highlight) use
// applyInlineStyleProperty/clearInlineStyleProperty instead, which merge
// into existing styling rather than destroying it.
export function clearStyling(text) {
  let cleared = text;
  cleared = cleared.replace(/<span style="[^"]*">/gi, "").replace(/<\/span>/gi, "");
  cleared = cleared.replace(/<font [^>]*>/gi, "").replace(/<\/font>/gi, "");
  cleared = cleared.replace(/<mark>/gi, "").replace(/<\/mark>/gi, "");
  cleared = cleared.replace(/<u>/gi, "").replace(/<\/u>/gi, "");
  cleared = cleared.replace(/<del>/gi, "").replace(/<\/del>/gi, "");
  cleared = cleared.replace(/<kbd[^>]*>/gi, "").replace(/<\/kbd>/gi, "");
  return cleared;
}

export function parseInlineStyle(styleAttr) {
  const props = {};
  String(styleAttr || "").split(";").forEach((decl) => {
    const idx = decl.indexOf(":");
    if (idx === -1) return;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop && value) props[prop] = value;
  });
  return props;
}

export function serializeInlineStyle(props) {
  return Object.entries(props).map(([k, v]) => `${k}: ${v};`).join(" ");
}

// A selection that is ENTIRELY one <span style="..."> wrapping — no partial
// wrap, no sibling spans, no unmatched nesting inside — so a font/color/
// highlight action can merge a property into it instead of stripping
// whatever styling is already there.
export function matchWholeStyleSpan(text) {
  const m = /^<span style="([^"]*)">([\s\S]*)<\/span>$/.exec(text);
  if (!m) return null;
  const inner = m[2];
  const opens = (inner.match(/<span\b/gi) || []).length;
  const closes = (inner.match(/<\/span>/gi) || []).length;
  if (opens !== closes) return null;
  return { styleAttr: m[1], inner };
}

// Sets one CSS property on the selection's existing style span (merging with
// whatever else is set — e.g. a prior color survives a later font change)
// instead of clearStyling's old behavior of nuking every other inline style/
// tag first. Falls back to a fresh wrap when the selection isn't already
// entirely one style span (e.g. plain text, or a selection spanning multiple
// runs) — in that case there's nothing to merge into.
export function applyInlineStyleProperty(text, property, value) {
  const whole = matchWholeStyleSpan(text);
  const props = whole ? parseInlineStyle(whole.styleAttr) : {};
  const inner = whole ? whole.inner : text;
  props[property] = value;
  return `<span style="${serializeInlineStyle(props)}">${inner}</span>`;
}

export function clearInlineStyleProperty(text, property) {
  const whole = matchWholeStyleSpan(text);
  if (!whole) return text;
  const props = parseInlineStyle(whole.styleAttr);
  delete props[property];
  return Object.keys(props).length
    ? `<span style="${serializeInlineStyle(props)}">${whole.inner}</span>`
    : whole.inner;
}

export function toggleBulletPoints(text) {
  const lines = text.split("\n");
  const allAreBulleted = lines.every(line => line.trim() === "" || line.trim().startsWith("- "));
  
  const formatted = lines.map(line => {
    if (allAreBulleted) {
      return line.replace(/^(\s*)-\s?/, "$1");
    } else {
      if (line.trim() === "") return line;
      if (line.trim().startsWith("- ")) return line;
      return "- " + line;
    }
  });
  return formatted.join("\n");
}

// ── Smart bulletify ────────────────────────────────────────────────────────
//
// toggleBulletPoints above is line-based: it puts a "- " in front of every line
// and takes it off again. That is the right answer when the text is already one
// idea per line, and useless for the case this exists for — a run-on paragraph
// that IS a list and was never written as one:
//
//   "You need eggs, flour and milk; whisk them together, then rest the batter."
//
// So a single-line selection is SEGMENTED first. Explicit separators win over
// sentence ends, because a writer who typed "1)" or " - " has already said where
// the breaks go. Sentence splitting is last and deliberately conservative — it
// reuses nothing clever, just the end-of-sentence punctuation followed by a
// capital, so an abbreviation mid-sentence does not become a bullet of its own.
export const BULLET_INLINE_NUMBER_RE = /\s+(?=\d+[.)]\s+\S)/g;

export const BULLET_INLINE_DASH_RE = /\s+(?:[-–—•]|\u2022)\s+/g;

export const BULLET_SENTENCE_RE = /(?<=[.!?])\s+(?=[A-Z(“"'\[])/g;

// A separator only counts if it produces more than one non-trivial piece —
// otherwise "e.g. one thing" becomes a single bullet with its "e.g." shaved off.
export function segmentForBullets(line) {
  const tidy = (parts) => parts.map((p) => p.trim()).filter((p) => p.length > 1);

  const numbered = tidy(line.split(BULLET_INLINE_NUMBER_RE)).map((p) => p.replace(/^\d+[.)]\s*/, ""));
  if (numbered.length > 1) return numbered;

  const dashed = tidy(line.split(BULLET_INLINE_DASH_RE));
  if (dashed.length > 1) return dashed;

  const semis = tidy(line.split(";"));
  if (semis.length > 1) return semis;

  const sentences = tidy(line.split(BULLET_SENTENCE_RE));
  if (sentences.length > 1) return sentences;

  return [line.trim()].filter(Boolean);
}

export function smartBulletify(text) {
  const lines = String(text || "").split("\n");
  const content = lines.filter((line) => line.trim());
  if (!content.length) return text;

  // Already a list? Then this is the "off" half of the toggle, exactly as
  // toggleBulletPoints does it — pressing the button twice has to give the text
  // back, not bullet the bullets.
  if (content.every((line) => LIST_LINE_RE.test(line))) {
    return lines.map((line) => line.replace(/^(\s*)(?:[-*+]|\d+[.)])[ \t]+/, "$1")).join("\n");
  }

  // Several lines already: one bullet each, which is what the reader means by
  // selecting several lines and pressing this.
  if (content.length > 1) {
    return lines
      .map((line) => (line.trim() ? line.replace(/^(\s*)/, "$1- ") : line))
      .join("\n");
  }

  return segmentForBullets(content[0]).map((part) => `- ${part}`).join("\n");
}

export const LIST_LINE_RE = /^\s*(?:[-*+]|\d+[.)])[ \t]+/;

// ── Quote it ───────────────────────────────────────────────────────────────
//
// The other thing a reader does to a passage they have just marked: set it off
// as a quotation. Same toggle contract as toggleBulletPoints above — press it
// twice and you get your text back — and deliberately NOT smartBulletify's
// sentence-splitting cleverness. A quote is somebody else's words, and breaking
// them up on the punctuation would be editing them.
//
// A line already quoted at any depth counts as quoted, so pressing this on a
// nested quote unwraps one level rather than adding a fifth `>`.
export const QUOTE_LINE_RE = /^(\s*)>[ \t]?/;

export function toggleBlockquote(text) {
  const lines = String(text || "").split("\n");
  const content = lines.filter((line) => line.trim());
  if (!content.length) return text;
  if (content.every((line) => QUOTE_LINE_RE.test(line))) {
    return lines.map((line) => line.replace(QUOTE_LINE_RE, "$1")).join("\n");
  }
  // A blank line inside a blockquote ENDS it — the lines after it read as a new
  // paragraph outside the quote. So the blanks are quoted too (as a bare ">"),
  // which is what keeps a two-paragraph passage one quotation.
  return lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n");
}

export function clearFormatting(text) {
  let cleared = text;
  
  // 1. Strip styling HTML wrappers
  cleared = clearStyling(cleared);
  
  // 2. Strip standard Markdown markup (bold, italic, strikethrough, inline code)
  cleared = cleared.replace(/\*\*([\s\S]*?)\*\*/g, "$1");
  cleared = cleared.replace(/__([\s\S]*?)__/g, "$1");
  cleared = cleared.replace(/\*([\s\S]*?)\*/g, "$1");
  cleared = cleared.replace(/_([\s\S]*?)_/g, "$1");
  cleared = cleared.replace(/~~([\s\S]*?)~~/g, "$1");
  cleared = cleared.replace(/`([\s\S]*?)`/g, "$1");
  
  // 3. Strip list bullets and header tags on each line
  const lines = cleared.split("\n");
  const processed = lines.map(line => {
    let l = line;
    l = l.replace(/^(\s*)[-*+]\s+/, "$1");
    l = l.replace(/^(\s*)\d+\.\s+/, "$1");
    l = l.replace(/^(\s*)#+\s+/, "$1");
    return l;
  });
  return processed.join("\n");
}
