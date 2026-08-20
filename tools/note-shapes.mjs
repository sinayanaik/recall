// The note shapes and edit shapes both split checks are driven against.
//
// One corpus, imported by tools/incremental-split-check.mjs (does an EDIT
// re-split the note into the same blocks a full re-lex would?) and by
// tools/viewport-split-check.mjs (does building a note SPAN BY SPAN, as the
// reader reaches each one, give the same blocks as lexing the whole document
// up front?). The two ask different questions of the same splitter, and a
// fixture that only one of them knows about is a shape the other is blind to —
// which is the entire reason this file exists rather than a second copy.
//
// These are PREPARED strings, which is what the splitters are contracted on —
// the design deliberately makes no claim about preprocessSpecialBlocks and
// diffs its output instead. So the fixtures carry the shapes preprocess really
// emits (a cloze span, a math div, a diagram div) rather than their markdown
// sources.

export function prose(n, tag = "P") {
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ");
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(`${tag}${String(i).padStart(4, "0")} ${words.join(" ")} and some more words to make a real line.`);
    out.push("");
  }
  return out.join("\n");
}

export const SHAPES = {
  "uniform prose": () => prose(120),

  "headings, prose and bullets": () => {
    const out = [];
    for (let i = 0; i < 40; i += 1) {
      out.push(`## Section ${i}`, "", prose(2, `S${i}`), "- one item", "- two item", "- three item", "");
    }
    return out.join("\n");
  },

  "fenced code with blank lines in it": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(prose(1, `F${i}`), "```js", `const a${i} = 1;`, "", `const b${i} = 2;`, "```", "");
    }
    return out.join("\n");
  },

  "a loose list": () => {
    const out = [prose(2, "LL")];
    for (let i = 0; i < 30; i += 1) out.push(`- loose item ${i} with a sentence after it`, "");
    out.push(prose(2, "LT"));
    return out.join("\n");
  },

  "a tight list": () => {
    const out = [prose(2, "TL"), ""];
    for (let i = 0; i < 30; i += 1) out.push(`${i + 1}. tight item ${i} with a sentence after it`);
    out.push("", prose(2, "TT"));
    return out.join("\n");
  },

  "blockquotes with lazy continuation": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(`> quoted line ${i} opening the quote`, `lazily continued line ${i} with no marker`, "", prose(1, `Q${i}`));
    }
    return out.join("\n");
  },

  "GFM tables": () => {
    const out = [];
    for (let i = 0; i < 20; i += 1) {
      out.push(prose(1, `T${i}`), "| Element | Symbol |", "| --- | --- |", `| Hydrogen ${i} | H |`, `| Helium ${i} | He |`, "");
    }
    return out.join("\n");
  },

  "link definitions in four positions": () => {
    const out = ["[top]: http://example.com/top", "", prose(20, "LD")];
    out.push("[mid]: http://example.com/mid", "");
    out.push("A paragraph with no blank line under it");
    out.push("[absorbed]: http://example.com/absorbed", "");
    out.push(prose(20, "LE"));
    out.push("[last]: http://example.com/last");
    return out.join("\n");
  },

  "setext headings": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(`Setext heading ${i}`, "================", "", prose(1, `X${i}`));
    }
    return out.join("\n");
  },

  "indented code after paragraphs": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(prose(1, `I${i}`), `    indented code line ${i}`, `    more indented code ${i}`, "");
    }
    return out.join("\n");
  },

  "inline cloze, math and diagram HTML": () => {
    const out = [];
    for (let i = 0; i < 25; i += 1) {
      out.push(`Paragraph M${i} with a <span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">hidden ${i}</span> in it.`, "");
      out.push(`<div class="math-display" data-tex="x%5E${i}"></div>`, "");
      out.push(`<div class="mermaid" data-diagram="graph%20TD%3B%20A${i}--%3EB${i}%3B"></div>`, "");
      out.push(prose(1, `M${i}`));
    }
    return out.join("\n");
  },

  "thematic breaks and raw html": () => {
    const out = [];
    for (let i = 0; i < 30; i += 1) {
      out.push(prose(1, `H${i}`), "---", `<div class="notes-img-row"><img src="a${i}.png" alt=""></div>`, "");
    }
    return out.join("\n");
  },

  // The contents is derived from the SOURCE now (scanPreparedHeadings), so what
  // a heading's markdown looks like is no longer cosmetic: the slug a
  // [[Note#heading]] link resolves against and the row the drawer shows both
  // come out of it. These two shapes are what tools/viewport-split-check.mjs
  // property D is really aimed at.
  "headings wearing inline markup": () => {
    const out = [];
    const dressings = [
      "**Bold** beginning", "A `code span` inside", "[A link](http://example.com/target)",
      "*Emphasis* and **strong** together", "An escaped \\# hash", "Trailing hashes ##",
      "Ampersand &amp; entity", "~~struck~~ through", "![alt text](http://example.com/i.png) after"
    ];
    dressings.forEach((text, i) => {
      out.push(`${"#".repeat((i % 5) + 1)} ${text}`, "", prose(1, `W${i}`));
    });
    return out.join("\n");
  },

  "headings inside blockquotes": () => {
    const out = [];
    for (let i = 0; i < 20; i += 1) {
      out.push(`> ## Quoted heading ${i}`, ">", `> quoted body line ${i}`, "", prose(1, `B${i}`));
    }
    return out.join("\n");
  },

  "no trailing newline": () => prose(60, "N").trimEnd(),

  "one block": () => "Just the one paragraph, nothing else at all in this note.",
};

// ── The edits ──────────────────────────────────────────────────────────────
//
// `at` is a fraction of the document, so every edit is tried near the top, in
// the middle and near the end — the head and tail of a note are where the
// window has to clamp rather than bail, and that was worth 10% of all accepted
// cases on its own.

export function spliceAt(text, fraction, remove, insert) {
  const want = Math.floor(text.length * fraction);
  // Land on a word boundary inside a line rather than mid-token: an edit that
  // cuts a word in half is a fine test of the guard but a poor test of anything
  // a reader actually does.
  let at = text.indexOf(" ", want);
  if (at === -1) at = want;
  at = Math.min(at + 1, text.length);
  return text.slice(0, at) + insert + text.slice(at + remove);
}

export const EDITS = {
  "highlight": (t, f) => spliceAt(t, f, 8, '<mark data-color="yellow">selected</mark>'),
  "recolour a highlight": (t, f) => spliceAt(t, f, 8, '<mark data-color="green">selected</mark>'),
  "multi-block highlight": (t, f) => spliceAt(t, f, 0, '<mark>one</mark>\n\n<mark>two</mark>\n\n'),
  "cloze": (t, f) => spliceAt(t, f, 6, '<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">hidden</span>'),
  "erase a phrase": (t, f) => spliceAt(t, f, 30, ""),
  "erase a whole block": (t, f) => spliceAt(t, f, 200, ""),
  "insert a paragraph": (t, f) => spliceAt(t, f, 0, "\n\nAn inserted paragraph with several words in it.\n\n"),
  "insert a heading": (t, f) => spliceAt(t, f, 0, "\n\n### An inserted heading\n\n"),
  "insert a blank line": (t, f) => spliceAt(t, f, 0, "\n"),
  "join two blocks": (t, f) => {
    const want = Math.floor(t.length * f);
    const at = t.indexOf("\n\n", want);
    return at === -1 ? t : t.slice(0, at) + "\n" + t.slice(at + 2);
  },
  "open an unbalanced fence": (t, f) => spliceAt(t, f, 0, "\n\n```\n"),
  "close a fence": (t, f) => spliceAt(t, f, 0, "\n```\n"),
  "add a table row": (t, f) => spliceAt(t, f, 0, "\n| Lithium | Li |"),
  "add a setext underline": (t, f) => spliceAt(t, f, 0, "\n===="),
  "add a link definition": (t, f) => spliceAt(t, f, 0, "\n\n[added]: http://example.com/added\n\n"),
  "remove a link definition": (t) => t.replace(/^\[mid\]: .*$\n/m, ""),
  "edit at offset 0": (t) => "A brand new first paragraph.\n\n" + t,
  "edit at the very end": (t) => t + "\n\nA brand new last paragraph.\n",
  "length-preserving replacement": (t, f) => spliceAt(t, f, 8, "REPLACED"),
};

export const AT = [0.05, 0.5, 0.93];

// Edits whose whole point is to disturb a block junction. They are expected to
// bail often, so they are exempt from the coverage floor — but never from the
// identity property.
export const DISRUPTIVE = new Set([
  "join two blocks", "open an unbalanced fence", "close a fence", "add a setext underline",
  "add a link definition", "remove a link definition", "erase a whole block", "add a table row",
]);
