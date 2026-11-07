// Markdown → PDF: the layout. Markdown in, a column of measured ROWS out.
//
// ── What a row is ──────────────────────────────────────────────────────────
//
// The smallest thing a page break never goes through: one line of a
// paragraph, one line of code, one table row, one list item's marker line, a
// picture, a formula, a rule. Each carries the drawing for itself (`ops`,
// relative to its own top-left) and, for the boundary ABOVE it, whether a page
// may break there and how good a place it is (`cut`) — the same scores the
// clipper extension's Smart pages give a web page's blocks
// (recall-clipper/content/prepare.js, scoreOf): before a heading is best, a
// paragraph boundary next, a list item or a table row after that, and the
// middle of a paragraph or a code block only when nothing better is in reach.
// The planner (md-pdf/breaks.js) never sees markdown, only these rows.
//
// So the layout is done ONCE, as one continuous column, and every page shape
// — smart pages, paper, one long page, two columns — is a way of slicing it.
// That is what lets the dialog's preview move a page break without laying the
// text out again, and what makes "the page breaks before this paragraph" a
// statement about the paragraph rather than a y coordinate.
//
// ── Units ──────────────────────────────────────────────────────────────────
//
// PDF points, y DOWNWARD from the top of the column (the writer flips it).
//
// ── What it reuses ─────────────────────────────────────────────────────────
//
// The markdown arrives already through preprocessSpecialBlocks
// (src/render/preprocess.js), the pass the Notes view runs: so $…$, $$…$$,
// \(…\), mermaid and nomnoml fences, {{clozes}} and side-by-side picture rows
// are recognised by exactly the rules a note is, and arrive here as the small
// HTML nodes that pass leaves (`.math-inline[data-tex]`, `.mermaid[data-diagram]`
// …). The tokens are the vendored marked's lexer. Pure: no DOM; pictures and
// glyph pictures are measured beforehand (md-pdf/assets.js) and handed in.

// ── Options ────────────────────────────────────────────────────────────────

export const MD_PDF_PAPERS = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008],
  A5: [419.53, 595.28]
};

// Page margins, in points: 5mm, 10mm, 15mm, 22mm.
export const MD_PDF_MARGINS = { none: 14, narrow: 28, normal: 42, wide: 62 };

// The tallest page a PDF may have (PDF's own UserUnit-less limit: 200 inches).
export const PDF_MAX_PAGE_PT = 14400;

export const MD_PDF_DEFAULTS = Object.freeze({
  layout: "smart",          // smart | paper | long
  pageLength: "a4",         // half | a4 | 2a4 | custom  (smart pages: about how tall one page is)
  customLength: 297,        // mm
  paper: "A4",              // A4 | Letter | Legal | A5 | match  (page width; and height for paper pages)
  columns: 1,               // 1 | 2
  breakBefore: "none",      // none | h1 | h2 | h3
  margin: "narrow",         // none | narrow | normal | wide
  textSize: 10.5,           // pt
  font: "sans",             // sans | serif
  pictures: "high",         // original | high | medium | low | none
  pageNumbers: false,
  bookmarks: true,
  codeColours: true
});

const ENUMS = {
  layout: ["smart", "paper", "long"],
  pageLength: ["half", "a4", "2a4", "custom"],
  paper: [...Object.keys(MD_PDF_PAPERS), "match"],
  breakBefore: ["none", "h1", "h2", "h3"],
  margin: Object.keys(MD_PDF_MARGINS),
  font: ["sans", "serif"],
  pictures: ["original", "high", "medium", "low", "none"]
};

export function normalizeMdPdfOptions(input) {
  const source = input && typeof input === "object" ? input : {};
  const out = { ...MD_PDF_DEFAULTS };
  for (const [key, values] of Object.entries(ENUMS)) {
    if (values.includes(source[key])) out[key] = source[key];
  }
  out.columns = Number(source.columns) === 2 ? 2 : 1;
  const size = Number(source.textSize);
  out.textSize = Number.isFinite(size) ? Math.min(16, Math.max(7, Math.round(size * 2) / 2)) : MD_PDF_DEFAULTS.textSize;
  const length = Number(source.customLength);
  out.customLength = Number.isFinite(length) ? Math.min(5000, Math.max(60, Math.round(length))) : MD_PDF_DEFAULTS.customLength;
  for (const key of ["pageNumbers", "bookmarks", "codeColours"]) {
    if (typeof source[key] === "boolean") out[key] = source[key];
  }
  return out;
}

const MM = 72 / 25.4;

// The page's shape for these options. `match` is the [width, height] of the
// page the new pages sit beside when inserting into a PDF (paper "match").
export function pageGeometry(options, match = null) {
  const o = normalizeMdPdfOptions(options);
  const [paperW, paperH] = o.paper === "match" && Array.isArray(match) && match[0] > 100
    ? [match[0], Math.max(200, match[1] || MD_PDF_PAPERS.A4[1])]
    : (MD_PDF_PAPERS[o.paper] || MD_PDF_PAPERS.A4);
  const marginX = MD_PDF_MARGINS[o.margin];
  const marginTop = marginX;
  // Page numbers sit in the foot margin; it grows to hold them.
  const footer = o.pageNumbers ? Math.max(0, 22 - marginX * 0.5) : 0;
  const marginBottom = marginX + footer;
  const contentWidth = paperW - 2 * marginX;
  const gutter = o.columns === 2 ? Math.max(12, o.textSize * 1.6) : 0;
  const columnWidth = o.columns === 2 ? (contentWidth - gutter) / 2 : contentWidth;
  // How much column one page holds.
  let pageContent;
  if (o.layout === "paper") pageContent = paperH - marginTop - marginBottom;
  else if (o.layout === "long") pageContent = PDF_MAX_PAGE_PT - marginTop - marginBottom;
  else {
    const length = o.pageLength === "half" ? paperH / 2
      : o.pageLength === "2a4" ? paperH * 2
        : o.pageLength === "custom" ? o.customLength * MM
          : paperH;
    pageContent = Math.min(PDF_MAX_PAGE_PT, length) - marginTop - marginBottom;
  }
  pageContent = Math.max(120, pageContent);
  return {
    pageWidth: paperW,
    paperHeight: paperH,
    marginX,
    marginTop,
    marginBottom,
    footer,
    contentWidth,
    columnWidth,
    gutter,
    pageContent,
    // No single row is laid out taller than this: a picture is scaled to fit
    // a page rather than cut by one.
    maxRowHeight: Math.min(pageContent, PDF_MAX_PAGE_PT - marginTop - marginBottom)
  };
}

// ── Colours (light paper, always: a PDF is printed and shared) ────────────

export const MD_PDF_COLOURS = {
  text: "#1b1d21",
  heading: "#0f1115",
  muted: "#5b616b",
  link: "#1a56b0",
  rule: "#c9ced6",
  codeBg: "#f4f5f7",
  codeSpanBg: "#eceef2",
  quoteBar: "#c3c8d0",
  tableBorder: "#c9ced6",
  tableHeadBg: "#f1f3f6",
  mark: "#fff1a6",
  cloze: "#e6ecfb",
  bullet: "#3b3f46"
};

// Prism token types → colours (a GitHub-light palette, readable printed).
export const CODE_COLOURS = {
  comment: "#6a737d", prolog: "#6a737d", doctype: "#6a737d", cdata: "#6a737d",
  keyword: "#cf222e", operator: "#cf222e", important: "#cf222e", atrule: "#cf222e",
  string: "#0a3069", char: "#0a3069", regex: "#0a3069", "attr-value": "#0a3069", url: "#0a3069",
  number: "#0550ae", boolean: "#0550ae", constant: "#0550ae", property: "#0550ae", symbol: "#0550ae",
  function: "#8250df", "class-name": "#8250df", "attr-name": "#8250df",
  builtin: "#953800", variable: "#953800", namespace: "#953800",
  tag: "#116329", selector: "#116329", inserted: "#116329", deleted: "#82071e",
  punctuation: "#24292f"
};

// ── Small helpers ──────────────────────────────────────────────────────────

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

export function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, name) => {
    if (name[0] === "#") {
      const cp = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try { return Number.isFinite(cp) && cp > 0 ? String.fromCodePoint(cp) : match; } catch { return match; }
    }
    return ENTITY[name.toLowerCase()] ?? match;
  });
}

function htmlTagAttr(tag, name) {
  const m = String(tag).match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : "";
}

function safeDecodeURIComponent(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

// A short, stable fingerprint of a block's source: what a page break is
// remembered against, so an edit elsewhere in the markdown leaves it in place.
export function hashText(text) {
  let h = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ── Tokens → a small document tree ─────────────────────────────────────────
//
// Inline pieces: { t: "text", text, s } | { t: "math", tex } | { t: "image",
// src, alt } | { t: "br" }. `s` is the style: b, i, code, del, u, mark, cloze,
// sub, sup, kbd, link (href, or "" for a link with nowhere to go).

const STYLE_TAGS = {
  b: "b", strong: "b", i: "i", em: "i", u: "u", ins: "u", mark: "mark",
  del: "del", s: "del", strike: "del", sub: "sub", sup: "sup", kbd: "kbd", code: "code"
};

export function inlinePieces(tokens, style = {}, out = []) {
  // Spans opened by an html token and closed by a later one, in this run.
  const stack = [];
  const current = () => stack.reduce((acc, extra) => ({ ...acc, ...extra }), style);
  for (const token of tokens || []) {
    const s = current();
    switch (token.type) {
      case "text":
      case "escape":
        if (token.tokens && token.tokens.length) inlinePieces(token.tokens, s, out);
        else out.push({ t: "text", text: decodeEntities(token.text), s });
        break;
      case "strong": inlinePieces(token.tokens, { ...s, b: true }, out); break;
      case "em": inlinePieces(token.tokens, { ...s, i: true }, out); break;
      case "del": inlinePieces(token.tokens, { ...s, del: true }, out); break;
      case "codespan": out.push({ t: "text", text: decodeEntities(token.text), s: { ...s, code: true } }); break;
      case "br": out.push({ t: "br" }); break;
      case "link": inlinePieces(token.tokens, { ...s, link: token.href || "" }, out); break;
      case "image": out.push({ t: "image", src: token.href || "", alt: decodeEntities(token.text || "") }); break;
      case "html": {
        const tag = String(token.text || "").trim();
        const open = tag.match(/^<([a-z][a-z0-9-]*)\b/i);
        const close = tag.match(/^<\/([a-z][a-z0-9-]*)\s*>/i);
        if (open) {
          const name = open[1].toLowerCase();
          const cls = htmlTagAttr(tag, "class");
          const selfClosing = /\/>$/.test(tag) || ["br", "img", "hr", "wbr"].includes(name);
          if (name === "br") { out.push({ t: "br" }); break; }
          if (name === "img") { out.push({ t: "image", src: htmlTagAttr(tag, "src"), alt: htmlTagAttr(tag, "alt") }); break; }
          if (/\bmath-inline\b/.test(cls) || /\bmath-display\b/.test(cls)) {
            out.push({ t: "math", tex: safeDecodeURIComponent(htmlTagAttr(tag, "data-tex")), display: /\bmath-display\b/.test(cls) });
            if (!selfClosing) stack.push({ __tag: name, __skip: true });
            break;
          }
          if (selfClosing) break;
          let extra = {};
          if (/\bcloze\b/.test(cls)) extra = { cloze: true };
          else if (name === "a") extra = { link: htmlTagAttr(tag, "href") || "" };
          else if (STYLE_TAGS[name]) extra = { [STYLE_TAGS[name]]: true };
          stack.push({ ...extra, __tag: name });
          break;
        }
        if (close) {
          const name = close[1].toLowerCase();
          for (let k = stack.length - 1; k >= 0; k -= 1) {
            if (stack[k].__tag === name) { stack.splice(k, 1); break; }
          }
        }
        break;
      }
      default:
        if (token.tokens) inlinePieces(token.tokens, s, out);
        else if (token.text) out.push({ t: "text", text: decodeEntities(token.text), s });
    }
  }
  return out.map((piece) => (piece.s ? { ...piece, s: cleanStyle(piece.s) } : piece));
}

function cleanStyle(s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) if (!k.startsWith("__") && v !== undefined && v !== false) out[k] = v;
  return out;
}

// Turn the top-level tokens into blocks: { type, … , src } where src is the
// block's own markdown (what its page breaks are remembered by).
export function blocksFromTokens(tokens) {
  const blocks = [];
  for (const token of tokens || []) {
    const block = blockFromToken(token);
    if (block) blocks.push(block);
  }
  return blocks;
}

function htmlBlock(token) {
  const text = String(token.text || "");
  const display = text.match(/class="math-display"[^>]*data-tex="([^"]*)"/);
  if (display) return { type: "math", tex: safeDecodeURIComponent(decodeEntities(display[1])) };
  const diagram = text.match(/<div class="(mermaid|nomnoml-diagram)[^"]*"[^>]*data-diagram="([^"]*)"/);
  if (diagram) {
    const width = text.match(/width:(\d+)px/);
    return {
      type: "diagram",
      kind: diagram[1] === "mermaid" ? "mermaid" : "nomnoml",
      source: safeDecodeURIComponent(decodeEntities(diagram[2])),
      width: width ? Number(width[1]) : 0
    };
  }
  const images = [...text.matchAll(/<img\b[^>]*>/gi)].map((m) => ({ t: "image", src: htmlTagAttr(m[0], "src"), alt: htmlTagAttr(m[0], "alt") }));
  if (images.length) return { type: "paragraph", inline: images };
  // Anything else: its words, as a paragraph.
  const plain = decodeEntities(text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).trim();
  if (!plain) return null;
  return { type: "paragraph", inline: [{ t: "text", text: plain, s: {} }] };
}

function blockFromToken(token) {
  const src = token.raw || "";
  switch (token.type) {
    case "heading":
      return { type: "heading", level: token.depth, inline: inlinePieces(token.tokens), src };
    case "paragraph":
    case "text":
      return { type: "paragraph", inline: inlinePieces(token.tokens || [{ type: "text", text: token.text }]), src };
    case "code": {
      const lang = String(token.lang || "").trim().split(/\s+/)[0].toLowerCase();
      return { type: "code", lang, text: String(token.text || "").replace(/\t/g, "    "), src };
    }
    case "blockquote":
      return { type: "quote", blocks: blocksFromTokens(token.tokens), src };
    case "list":
      return {
        type: "list",
        ordered: Boolean(token.ordered),
        start: Number(token.start) || 1,
        loose: Boolean(token.loose),
        items: (token.items || []).map((item) => ({
          task: Boolean(item.task),
          checked: Boolean(item.checked),
          blocks: blocksFromTokens(item.tokens),
          src: item.raw || ""
        })),
        src
      };
    case "table":
      return {
        type: "table",
        align: token.align || [],
        header: (token.header || []).map((cell) => inlinePieces(cell.tokens)),
        rows: (token.rows || []).map((row) => row.map((cell) => inlinePieces(cell.tokens))),
        src
      };
    case "hr":
      return { type: "hr", src };
    case "html": {
      const block = htmlBlock(token);
      return block ? { ...block, src } : null;
    }
    case "space":
    case "def":
      return null;
    default:
      if (token.tokens) return { type: "paragraph", inline: inlinePieces(token.tokens), src };
      return null;
  }
}

// Everything the assets stage has to prepare before layout: fonts' text, by
// family and style; formulas; diagrams; pictures.
export function collectNeeds(blocks) {
  const needs = { text: [], maths: new Map(), diagrams: new Map(), images: new Map(), codeLangs: new Set() };
  const addText = (text, family, bold, italic) => {
    if (text) needs.text.push({ text, family, bold: Boolean(bold), italic: Boolean(italic) });
  };
  const visitInline = (pieces, base = {}) => {
    for (const piece of pieces || []) {
      if (piece.t === "text") {
        const s = piece.s || {};
        addText(piece.text, s.code || s.kbd ? "mono" : base.family || "body", s.b || base.bold, s.i || base.italic);
      } else if (piece.t === "math") {
        needs.maths.set(mathKey(piece.tex, piece.display), { tex: piece.tex, display: Boolean(piece.display) });
      } else if (piece.t === "image" && piece.src) {
        needs.images.set(piece.src, { src: piece.src, alt: piece.alt });
      }
    }
  };
  const visit = (list) => {
    for (const block of list || []) {
      if (block.type === "heading") visitInline(block.inline, { bold: true });
      else if (block.type === "paragraph") visitInline(block.inline);
      else if (block.type === "code") {
        addText(block.text, "mono", false, false);
        if (block.lang) needs.codeLangs.add(block.lang);
      }
      else if (block.type === "quote") visit(block.blocks);
      else if (block.type === "list") {
        block.items.forEach((item) => visit(item.blocks));
        addText("0123456789.", "body", false, false);
      } else if (block.type === "table") {
        block.header.forEach((cell) => visitInline(cell, { bold: true }));
        block.rows.forEach((row) => row.forEach((cell) => visitInline(cell)));
      } else if (block.type === "math") needs.maths.set(mathKey(block.tex, true), { tex: block.tex, display: true });
      else if (block.type === "diagram") needs.diagrams.set(diagramKey(block), { kind: block.kind, source: block.source, width: block.width });
    }
  };
  visit(blocks);
  // Page numbers and the space every line measures.
  addText("0123456789 /", "body", false, false);
  return needs;
}

export const mathKey = (tex, display) => `${display ? "D" : "I"}:${tex}`;
export const diagramKey = (block) => `${block.kind}:${block.width || 0}:${block.source}`;
export const glyphKey = (word, family, bold, italic) => `${family}|${bold ? 1 : 0}|${italic ? 1 : 0}|${word}`;

// ── Layout ─────────────────────────────────────────────────────────────────

const HEADING_SIZE = [1.55, 1.3, 1.15, 1.04, 1, 0.95];
const HEADING_SCORE = [5, 4, 3, 2, 2, 2];
const LINE = 1.32;
const CODE_SCALE = 0.88;
const TABLE_SCALE = 0.92;

// assets: {
//   math(key) → { key, w, h, depth } (points, at the text size given in options) | null
//   diagram(key) → { key, w, h } | null
//   image(src) → { key, w, h } | null       (natural size in points)
//   glyph(key) → { key, wPer, hPer, ascentPer } | null  (per point of text size)
//   highlight(code, lang) → [{ text, type }] | null
// }
export function layoutMarkdown({ blocks, fontSet, options, geometry, assets = {} }) {
  const o = normalizeMdPdfOptions(options);
  const g = geometry || pageGeometry(o);
  const body = o.font === "serif" ? "serif" : "sans";
  const size = o.textSize;
  const rows = [];
  const headings = [];
  const anchors = new Map();
  const usedSlugs = new Map();
  let y = 0;
  let pendingGap = 0;
  let decoSeq = 0;
  // The fingerprint of each top-level block, counted, so two identical
  // paragraphs keep distinct page breaks.
  const seenHash = new Map();
  // Set by the block being laid out: the key prefix, and the cut its FIRST row
  // offers (everything after it in the block offers less).
  let blockKey = "";
  let rowInBlock = 0;
  let firstCut = null;
  let previousWasHeading = false;
  // Body text colour: grey inside a quote.
  let textColour = MD_PDF_COLOURS.text;

  const family = (s) => (s && (s.code || s.kbd) ? "mono" : body);

  // ── one line of inline content ──────────────────────────────────────────

  // Break pieces into boxes: { kind: "word"|"space"|"atom"|"br", w, runs, … }.
  function boxesFor(pieces, base) {
    const boxes = [];
    const textSize = base.size;
    for (const piece of pieces) {
      if (piece.t === "br") { boxes.push({ kind: "br" }); continue; }
      if (piece.t === "math") {
        const asset = assets.math ? assets.math(mathKey(piece.tex, piece.display)) : null;
        if (asset) {
          const scale = textSize / size;
          boxes.push({ kind: "atom", w: asset.w * scale, h: asset.h * scale, depth: (asset.depth || 0) * scale, image: asset.key, style: {} });
        } else {
          pushText(boxes, piece.display ? piece.tex : piece.tex, { code: true }, base);
        }
        continue;
      }
      if (piece.t === "image") {
        const asset = assets.image ? assets.image(piece.src) : null;
        if (asset && asset.w > 0 && asset.h > 0) boxes.push({ kind: "atom", w: asset.w, h: asset.h, depth: 0, image: asset.key, picture: true, style: {} });
        else if (o.pictures !== "none" && piece.alt) pushText(boxes, `[${piece.alt}]`, { i: true }, base, MD_PDF_COLOURS.muted);
        continue;
      }
      pushText(boxes, piece.text, piece.s || {}, base);
    }
    return boxes;
  }

  function pushText(boxes, text, s, base, colourOverride = null) {
    const style = { ...base.style, ...s };
    const fam = base.forceFamily || family(style);
    const bold = Boolean(style.b || base.bold);
    const italic = Boolean(style.i || base.italic);
    let pieceSize = base.size * (style.code && !base.forceFamily ? CODE_SCALE : 1);
    if (style.sub || style.sup) pieceSize *= 0.72;
    const colour = colourOverride || (style.link !== undefined && style.link !== "" ? MD_PDF_COLOURS.link : base.colour);
    const parts = String(text).replace(/\r/g, "").split(base.pre ? /( )/ : /(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (!base.pre && /^\s+$/.test(part)) {
        // Collapsed, as HTML does; a non-breaking space is part of a word.
        const prev = boxes[boxes.length - 1];
        if (prev && prev.kind === "space") continue;
        const face = fontSet.faceFor(32, fam, bold, italic);
        boxes.push({ kind: "space", w: face ? fontSet.measure(" ", face, pieceSize) : pieceSize * 0.28, style, size: pieceSize, colour });
        continue;
      }
      if (base.pre && part === " ") {
        const face = fontSet.faceFor(32, fam, bold, italic);
        boxes.push({ kind: "word", w: face ? fontSet.measure(" ", face, pieceSize) : pieceSize * 0.6, runs: face ? [{ text: " ", face }] : [], style, size: pieceSize, colour, fam, bold, italic });
        continue;
      }
      const runs = fontSet.splitByFace(part, fam, bold, italic);
      if (runs.some((run) => !run.face)) {
        // A word with a character no embedded face has: drawn as a picture of
        // the whole word, which the browser's text engine shapes properly
        // (Devanagari, Arabic, emoji). Without a picture for it, the
        // characters that cannot be drawn are left out rather than tofu'd.
        const glyph = assets.glyph ? assets.glyph(glyphKey(part, fam, bold, italic)) : null;
        if (glyph) {
          boxes.push({
            kind: "atom",
            w: glyph.wPer * pieceSize,
            h: glyph.hPer * pieceSize,
            depth: (glyph.hPer - glyph.ascentPer) * pieceSize,
            image: glyph.key,
            style
          });
          continue;
        }
        const kept = runs.filter((run) => run.face);
        if (!kept.length) continue;
        boxes.push(wordBox(kept, style, pieceSize, colour));
        continue;
      }
      boxes.push(wordBox(runs, style, pieceSize, colour));
    }
  }

  function wordBox(runs, style, pieceSize, colour) {
    const measured = runs.map((run) => ({ ...run, w: fontSet.measure(run.text, run.face, pieceSize) }));
    return { kind: "word", w: measured.reduce((sum, run) => sum + run.w, 0), runs: measured, style, size: pieceSize, colour };
  }

  // Split a word wider than the line into pieces that fit (by character).
  function splitWord(box, width) {
    const out = [];
    let current = { ...box, runs: [], w: 0 };
    for (const run of box.runs) {
      for (const ch of run.text) {
        const w = fontSet.measure(ch, run.face, box.size);
        if (current.w + w > width && current.w > 0) {
          out.push(current);
          current = { ...box, runs: [], w: 0 };
        }
        const last = current.runs[current.runs.length - 1];
        if (last && last.face === run.face) { last.text += ch; last.w += w; } else current.runs.push({ text: ch, face: run.face, w });
        current.w += w;
      }
    }
    if (current.runs.length) out.push(current);
    return out;
  }

  // Lines from boxes, greedy. Returns [{ items: [{box, x}], w, above, below }].
  function breakLines(boxes, width, base) {
    const lines = [];
    let line = { items: [], w: 0 };
    const flush = (force = false) => {
      // Trailing spaces never count toward a line's width.
      while (line.items.length && line.items[line.items.length - 1].box.kind === "space") {
        const sp = line.items.pop();
        line.w -= sp.box.w;
      }
      if (line.items.length || force) lines.push(line);
      line = { items: [], w: 0 };
    };
    for (let box of boxes) {
      if (box.kind === "br") { flush(true); continue; }
      if (box.kind === "space") {
        if (!line.items.length) continue;
        line.items.push({ box, x: line.w });
        line.w += box.w;
        continue;
      }
      if (box.kind === "atom" && box.w > width) {
        // A picture or formula wider than the column is scaled to it.
        const k = width / box.w;
        box = { ...box, w: width, h: box.h * k, depth: box.depth * k };
      }
      if (line.w + box.w > width + 0.01 && line.items.length) flush();
      if (box.kind === "word" && box.w > width) {
        const pieces = splitWord(box, width);
        pieces.forEach((piece, index) => {
          if (index > 0) flush();
          line.items.push({ box: piece, x: line.w });
          line.w += piece.w;
        });
        continue;
      }
      line.items.push({ box, x: line.w });
      line.w += box.w;
    }
    flush();
    // Vertical metrics.
    for (const l of lines) {
      const half = (base.size * base.lh - base.size) / 2;
      let above = half + base.size * 0.8;
      let below = half + base.size * 0.22;
      for (const { box } of l.items) {
        if (box.kind === "atom") {
          above = Math.max(above, box.h - box.depth + (box.picture ? 2 : 1));
          below = Math.max(below, box.depth + (box.picture ? 2 : 1));
        } else if (box.kind === "word" && box.size > base.size) {
          above = Math.max(above, box.size * 0.95);
          below = Math.max(below, box.size * 0.25);
        }
      }
      l.above = above;
      l.below = below;
    }
    return lines;
  }

  // Drawing ops for one line, its top at 0, its left at x0.
  function lineOps(l, x0, width, align, base) {
    const ops = [];
    const shift = align === "center" ? (width - l.w) / 2 : align === "right" ? width - l.w : 0;
    const baseline = l.above;
    let textOp = null;
    let linkOp = null;
    const decorate = [];
    for (const { box, x } of l.items) {
      const left = x0 + shift + x;
      const style = box.style || {};
      if (box.kind === "atom") {
        textOp = null;
        ops.push({ t: "image", key: box.image, x: left, y: baseline - (box.h - box.depth), w: box.w, h: box.h });
      } else if (box.kind === "word") {
        let yOffset = 0;
        if (style.sup) yOffset = -base.size * 0.33;
        if (style.sub) yOffset = base.size * 0.18;
        let runX = left;
        for (const run of box.runs) {
          if (textOp && textOp.face === run.face && textOp.size === box.size && textOp.colour === box.colour
            && textOp.yOffset === yOffset && Math.abs(textOp.x + textOp.w - runX) < 0.01 && !box.colourRuns) {
            textOp.text += run.text;
            textOp.w += run.w;
          } else {
            textOp = { t: "text", text: run.text, face: run.face, size: box.size, colour: run.colour || box.colour, x: runX, y: baseline + yOffset, yOffset, w: run.w };
            ops.push(textOp);
          }
          runX += run.w;
        }
      } else if (box.kind === "space") {
        // A space joins the run before it when the next word continues it —
        // fewer, longer text operators make a smaller file.
        if (textOp && box.size === textOp.size) {
          const face = textOp.face;
          if (fontSet.hasGlyph(face, 32)) {
            textOp.text += " ";
            textOp.w += box.w;
          } else textOp = null;
        } else textOp = null;
      }
      // Backgrounds and lines along the box.
      const w = box.w;
      if (box.kind !== "space" || (style.link !== undefined || style.u || style.del || style.mark || style.cloze || style.code)) {
        if (style.code || style.kbd) decorate.push({ t: "rect", x: left - 1, y: baseline - box.size * 0.82, w: w + 2, h: box.size * 1.08, fill: MD_PDF_COLOURS.codeSpanBg, group: "code" });
        if (style.mark) decorate.push({ t: "rect", x: left, y: baseline - base.size * 0.85, w, h: base.size * 1.1, fill: MD_PDF_COLOURS.mark, group: "mark" });
        if (style.cloze) decorate.push({ t: "rect", x: left, y: baseline - base.size * 0.85, w, h: base.size * 1.1, fill: MD_PDF_COLOURS.cloze, group: "cloze" });
        if (style.u || (style.link !== undefined && style.link !== "")) decorate.push({ t: "line", x1: left, x2: left + w, y: baseline + base.size * 0.12, colour: style.link ? MD_PDF_COLOURS.link : box.colour || base.colour, lw: 0.5, group: style.link ? "link-u" : "u" });
        if (style.del) decorate.push({ t: "line", x1: left, x2: left + w, y: baseline - base.size * 0.28, colour: box.colour || base.colour, lw: 0.6, group: "del" });
        if (style.link) {
          if (linkOp && linkOp.href === style.link && Math.abs(linkOp.x + linkOp.w - left) < 0.5) linkOp.w = left + w - linkOp.x;
          else {
            linkOp = { t: "link", href: style.link, x: left, y: 0, w, h: l.above + l.below };
            ops.push(linkOp);
          }
        } else if (box.kind !== "space") linkOp = null;
      }
    }
    // Merge touching decorations of the same kind (a code span of three words
    // is one grey box, an underline one line).
    const merged = [];
    for (const d of decorate) {
      const last = merged[merged.length - 1];
      if (last && last.group === d.group && last.t === d.t) {
        if (d.t === "rect" && Math.abs(last.x + last.w - d.x) < 2.5 && last.y === d.y) { last.w = d.x + d.w - last.x; continue; }
        if (d.t === "line" && Math.abs(last.x2 - d.x1) < 2.5 && last.y === d.y) { last.x2 = d.x2; continue; }
      }
      merged.push({ ...d });
    }
    // Backgrounds under the text, lines over it.
    return [...merged.filter((d) => d.t === "rect"), ...ops, ...merged.filter((d) => d.t === "line")];
  }

  // ── rows ────────────────────────────────────────────────────────────────

  function pushRow(h, ops, { gapBefore = 0, cut = undefined, decos = [], extra = null } = {}) {
    const gap = rows.length ? Math.max(pendingGap, gapBefore) : 0;
    y += gap;
    pendingGap = 0;
    const key = `${blockKey}:${rowInBlock}`;
    let rowCut = null;
    if (rows.length) {
      if (rowInBlock === 0) rowCut = firstCut || { score: 1, clean: true };
      else rowCut = cut || { score: 0, clean: false };
      if (cut && rowInBlock === 0) rowCut = cut;
      if (previousWasHeading) rowCut = { ...rowCut, clean: false, score: Math.min(rowCut.score, 0) };
    }
    const row = { y, h, ops, cut: rowCut, key, decos };
    if (extra) Object.assign(row, extra);
    rows.push(row);
    y += h;
    rowInBlock += 1;
    previousWasHeading = false;
    return row;
  }

  function addGap(gap) { pendingGap = Math.max(pendingGap, gap); }

  // Inline content as rows. `ctx`: { x, width, decos }.
  function inlineRows(pieces, ctx, base, { align = "left", lineCut = null, firstOps = null } = {}) {
    const boxes = boxesFor(pieces, base);
    const lines = breakLines(boxes, ctx.width, base);
    if (!lines.length) return [];
    const made = [];
    lines.forEach((l, index) => {
      const ops = lineOps(l, ctx.x, ctx.width, align, base);
      if (index === 0 && firstOps) ops.unshift(...firstOps(l));
      made.push(pushRow(l.above + l.below, ops, { decos: ctx.decos, cut: index === 0 ? undefined : (lineCut || { score: 0, clean: false }) }));
    });
    return made;
  }

  function baseStyle(extra = {}) {
    return { size, lh: LINE, colour: textColour, style: {}, ...extra };
  }

  function layoutBlocks(list, ctx, depth = 0) {
    list.forEach((block, index) => layoutBlock(block, ctx, depth, index === 0));
  }

  function startBlock(block, ctx, cut) {
    // Only TOP-level blocks start a key and decide their own first cut; a
    // block nested in a list item or a quote continues its parent's.
    if (ctx.top) {
      const hash = hashText(block.src || JSON.stringify(block).slice(0, 400));
      const n = (seenHash.get(hash) || 0) + 1;
      seenHash.set(hash, n);
      blockKey = `${hash}.${n}`;
      rowInBlock = 0;
      firstCut = cut;
    }
  }

  function layoutBlock(block, ctx, depth, isFirstInContainer) {
    const nestedCut = ctx.top ? null : { score: ctx.itemScore || 0, clean: Boolean(ctx.itemClean && isFirstInContainer) };
    switch (block.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, block.level || 1));
        const hs = size * HEADING_SIZE[level - 1];
        startBlock(block, ctx, { score: HEADING_SCORE[level - 1], clean: true, heading: level });
        addGap(hs * (level <= 2 ? 0.75 : 0.6));
        const text = block.inline.filter((p) => p.t === "text").map((p) => p.text).join("").trim();
        let slug = slugify(text);
        const count = usedSlugs.get(slug) || 0;
        usedSlugs.set(slug, count + 1);
        if (count) slug = `${slug}-${count}`;
        const made = inlineRows(block.inline, ctx, baseStyle({ size: hs, lh: 1.22, colour: MD_PDF_COLOURS.heading, bold: true }));
        if (made.length) {
          const first = made[0];
          first.heading = { level, text, slug };
          headings.push({ level, text, slug, row: rows.indexOf(first) });
          anchors.set(slug, rows.indexOf(first));
          // A cut placed right after a heading leaves it alone at a page's
          // foot: the planner never chooses one there.
          made.forEach((row, i) => { if (i > 0) row.cut = { score: 0, clean: false }; });
          previousWasHeading = true;
        }
        addGap(hs * 0.28);
        return;
      }
      case "paragraph": {
        startBlock(block, ctx, nestedCut);
        const onlyPictures = block.inline.length && block.inline.every((p) => p.t === "image" || (p.t === "text" && !p.text.trim()) || p.t === "br");
        if (onlyPictures) {
          layoutPictures(block.inline.filter((p) => p.t === "image"), ctx);
        } else {
          inlineRows(block.inline, ctx, baseStyle());
        }
        addGap(size * 0.55);
        return;
      }
      case "code": {
        startBlock(block, ctx, nestedCut);
        addGap(size * 0.35);
        const codeSize = size * CODE_SCALE;
        const pad = 4;
        const id = `code${decoSeq += 1}`;
        const deco = { id, kind: "bg", x: ctx.x, w: ctx.width, colour: MD_PDF_COLOURS.codeBg };
        const tokens = o.codeColours && assets.highlight ? assets.highlight(block.text, block.lang) : null;
        const lines = splitCodeLines(block.text, tokens);
        const inner = { x: ctx.x + pad + 2, width: ctx.width - 2 * pad - 4, decos: [...(ctx.decos || []), deco] };
        lines.forEach((pieces, index) => {
          const base = baseStyle({ size: codeSize, lh: 1.28, forceFamily: "mono", pre: true, style: {} });
          const boxes = [];
          for (const piece of pieces) pushText(boxes, piece.text, {}, base, piece.colour || textColour);
          const wrapped = breakLines(boxes, inner.width, base);
          if (!wrapped.length) wrapped.push({ items: [], w: 0, above: codeSize * 1.28 * 0.78, below: codeSize * 1.28 * 0.22 });
          wrapped.forEach((l, k) => {
            const top = index === 0 && k === 0 ? pad : 0;
            const bottom = index === lines.length - 1 && k === wrapped.length - 1 ? pad : 0;
            const ops = lineOps(l, inner.x, inner.width, "left", base).map((op) => shiftOp(op, top));
            pushRow(l.above + l.below + top + bottom, ops, { decos: inner.decos, cut: { score: 0, clean: false } });
          });
        });
        addGap(size * 0.55);
        return;
      }
      case "quote": {
        startBlock(block, ctx, nestedCut);
        addGap(size * 0.3);
        const id = `quote${decoSeq += 1}`;
        const bar = { id, kind: "bar", x: ctx.x, w: 2.2, colour: MD_PDF_COLOURS.quoteBar };
        const inner = { ...ctx, top: false, x: ctx.x + 10, width: ctx.width - 10, decos: [...(ctx.decos || []), bar], itemScore: 0, itemClean: false, quote: true };
        layoutBlocksMuted(block.blocks, inner, depth);
        addGap(size * 0.55);
        return;
      }
      case "list": {
        startBlock(block, ctx, nestedCut);
        const markerW = block.ordered ? Math.max(size * 1.5, measureBody(`${block.start + block.items.length - 1}.`, size) + size * 0.5) : size * 1.25;
        block.items.forEach((item, index) => {
          // Between items the list's own spacing, not the paragraph gap the
          // item's last paragraph asked for: a tight list is tight.
          if (index > 0) pendingGap = block.loose ? size * 0.45 : size * 0.14;
          const inner = { ...ctx, top: false, x: ctx.x + markerW, width: ctx.width - markerW, itemScore: ctx.top ? 0.5 : 0, itemClean: Boolean(ctx.top && !ctx.quote) };
          const startRow = rows.length;
          const itemBlocks = item.blocks.length ? item.blocks : [{ type: "paragraph", inline: [{ t: "text", text: " ", s: {} }] }];
          layoutBlocks(itemBlocks, inner, depth + 1);
          const first = rows[startRow];
          if (!first) return;
          if (index > 0) first.cut = { score: ctx.top ? 0.5 : 0, clean: Boolean(ctx.top && !ctx.quote) };
          // The marker on the item's first line, at its baseline.
          const baseline = firstBaseline(first);
          const mx = ctx.x;
          if (item.task) {
            const box = size * 0.78;
            first.ops.unshift({ t: "rect", x: mx + 1, y: baseline - box * 0.9, w: box, h: box, stroke: MD_PDF_COLOURS.bullet, lw: 0.7 });
            if (item.checked) first.ops.unshift({ t: "check", x: mx + 1, y: baseline - box * 0.9, w: box, h: box, colour: MD_PDF_COLOURS.bullet });
          } else if (block.ordered) {
            const label = `${block.start + index}.`;
            const face = fontSet.faceFor(48, body, false, false);
            if (face) {
              const w = fontSet.measure(label, face, size);
              first.ops.unshift({ t: "text", text: label, face, size, colour: MD_PDF_COLOURS.bullet, x: mx + markerW - w - size * 0.4, y: baseline, w });
            }
          } else {
            const r = size * 0.16;
            const kind = depth % 3;
            first.ops.unshift({ t: kind === 2 ? "square" : "dot", hollow: kind === 1, x: mx + size * 0.45, y: baseline - size * 0.3, r, colour: MD_PDF_COLOURS.bullet });
          }
        });
        addGap(size * 0.55);
        return;
      }
      case "table": {
        startBlock(block, ctx, nestedCut);
        addGap(size * 0.35);
        layoutTable(block, ctx);
        addGap(size * 0.6);
        return;
      }
      case "hr": {
        startBlock(block, ctx, { score: 2, clean: true });
        addGap(size * 0.4);
        pushRow(6, [{ t: "line", x1: ctx.x, x2: ctx.x + ctx.width, y: 3, colour: MD_PDF_COLOURS.rule, lw: 0.6 }], { decos: ctx.decos });
        addGap(size * 0.4);
        return;
      }
      case "math": {
        startBlock(block, ctx, nestedCut);
        addGap(size * 0.35);
        const asset = assets.math ? assets.math(mathKey(block.tex, true)) : null;
        if (asset) {
          let { w, h } = asset;
          const k = Math.min(1, ctx.width / w, g.maxRowHeight / h);
          w *= k; h *= k;
          pushRow(h + 2, [{ t: "image", key: asset.key, x: ctx.x + (ctx.width - w) / 2, y: 1, w, h }], { decos: ctx.decos });
        } else {
          inlineRows([{ t: "text", text: block.tex, s: { code: true } }], ctx, baseStyle(), { align: "center" });
        }
        addGap(size * 0.45);
        return;
      }
      case "diagram": {
        startBlock(block, ctx, nestedCut);
        addGap(size * 0.4);
        const asset = assets.diagram ? assets.diagram(diagramKey(block)) : null;
        if (asset) {
          let { w, h } = asset;
          const k = Math.min(1, ctx.width / w, g.maxRowHeight / h);
          w *= k; h *= k;
          pushRow(h, [{ t: "image", key: asset.key, x: ctx.x + (ctx.width - w) / 2, y: 0, w, h }], { decos: ctx.decos });
        } else {
          layoutBlock({ type: "code", lang: block.kind, text: block.source, src: block.src }, { ...ctx, top: false }, depth, isFirstInContainer);
        }
        addGap(size * 0.5);
        return;
      }
      default:
    }
  }

  // A quote's paragraphs are grey; the rest of the layout is unchanged.
  function layoutBlocksMuted(list, ctx, depth) {
    const saved = textColour;
    textColour = MD_PDF_COLOURS.muted;
    try { layoutBlocks(list, ctx, depth); } finally { textColour = saved; }
  }

  function measureBody(text, s) {
    let w = 0;
    for (const run of fontSet.splitByFace(text, body, false, false)) if (run.face) w += fontSet.measure(run.text, run.face, s);
    return w;
  }

  function firstBaseline(row) {
    const text = row.ops.find((op) => op.t === "text");
    if (text) return text.y - (text.yOffset || 0);
    return Math.min(row.h, size * 1.05);
  }

  // Pictures on their own: one row per line of them, side by side where they
  // fit (a row of pictures written as `![a](x) | ![b](y)` arrives this way).
  function layoutPictures(images, ctx) {
    const gap = 6;
    let line = [];
    let lineW = 0;
    const flush = () => {
      if (!line.length) return;
      const h = Math.max(...line.map((p) => p.h));
      let x = ctx.x;
      const ops = line.map((p) => {
        const op = { t: "image", key: p.key, x, y: h - p.h, w: p.w, h: p.h };
        x += p.w + gap;
        return op;
      });
      pushRow(h + 2, ops, { decos: ctx.decos, cut: { score: 0.5, clean: true } });
      line = [];
      lineW = 0;
    };
    for (const image of images) {
      const asset = assets.image ? assets.image(image.src) : null;
      if (!asset || !(asset.w > 0)) {
        if (o.pictures !== "none" && image.alt) inlineRows([{ t: "text", text: `[${image.alt}]`, s: { i: true } }], ctx, baseStyle({ colour: MD_PDF_COLOURS.muted }));
        continue;
      }
      let { w, h } = asset;
      const k = Math.min(1, ctx.width / w, g.maxRowHeight / h);
      w *= k; h *= k;
      if (line.length && lineW + gap + w > ctx.width) flush();
      line.push({ key: asset.key, w, h });
      lineW += (line.length > 1 ? gap : 0) + w;
    }
    flush();
  }

  function layoutTable(block, ctx) {
    const cols = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
    const tSize = size * TABLE_SCALE;
    const padX = 3.5;
    const padY = 2.2;
    const headBase = baseStyle({ size: tSize, lh: 1.25, bold: true, colour: MD_PDF_COLOURS.heading });
    const cellBase = baseStyle({ size: tSize, lh: 1.25 });
    const all = [block.header, ...block.rows];
    // Natural (one line) and minimum (longest word) width of each column.
    const natural = new Array(cols).fill(0);
    const minimum = new Array(cols).fill(0);
    all.forEach((row, r) => {
      for (let c = 0; c < cols; c += 1) {
        const boxes = boxesFor(row[c] || [], r === 0 ? headBase : cellBase);
        let total = 0;
        let longest = 0;
        for (const box of boxes) {
          if (box.kind === "br") continue;
          total += box.w;
          if (box.kind !== "space") longest = Math.max(longest, box.w);
        }
        natural[c] = Math.max(natural[c], total + 2 * padX);
        minimum[c] = Math.max(minimum[c], Math.min(longest, ctx.width / cols) + 2 * padX);
      }
    });
    let widths;
    const sumNatural = natural.reduce((a, b) => a + b, 0);
    if (sumNatural <= ctx.width) widths = natural.map((w) => Math.max(w, 18));
    else {
      const sumMin = minimum.reduce((a, b) => a + b, 0);
      if (sumMin >= ctx.width) widths = minimum.map((w) => (w * ctx.width) / sumMin);
      else {
        const spare = ctx.width - sumMin;
        const want = natural.map((w, c) => Math.max(0, w - minimum[c]));
        const sumWant = want.reduce((a, b) => a + b, 0) || 1;
        widths = minimum.map((w, c) => w + (spare * want[c]) / sumWant);
      }
    }
    const tableW = widths.reduce((a, b) => a + b, 0);
    const xs = [];
    widths.reduce((x, w) => { xs.push(x); return x + w; }, ctx.x);
    const align = (c) => (block.align[c] === "center" ? "center" : block.align[c] === "right" ? "right" : "left");
    let headerRow = null;
    all.forEach((cells, r) => {
      const base = r === 0 ? headBase : cellBase;
      const laid = [];
      for (let c = 0; c < cols; c += 1) laid.push(breakLines(boxesFor(cells[c] || [], base), Math.max(4, widths[c] - 2 * padX), base));
      const heights = laid.map((lines) => lines.reduce((sum, l) => sum + l.above + l.below, 0));
      const h = Math.max(tSize * 1.25, ...heights) + 2 * padY;
      const ops = [];
      if (r === 0) ops.push({ t: "rect", x: ctx.x, y: 0, w: tableW, h, fill: MD_PDF_COLOURS.tableHeadBg });
      laid.forEach((lines, c) => {
        let top = padY;
        for (const l of lines) {
          lineOps(l, xs[c] + padX, widths[c] - 2 * padX, align(c), base).forEach((op) => ops.push(shiftOp(op, top)));
          top += l.above + l.below;
        }
      });
      const border = { colour: MD_PDF_COLOURS.tableBorder, lw: 0.5 };
      if (r === 0) ops.push({ t: "line", x1: ctx.x, x2: ctx.x + tableW, y: 0, ...border });
      ops.push({ t: "line", x1: ctx.x, x2: ctx.x + tableW, y: h, ...border });
      [...xs, ctx.x + tableW].forEach((x) => ops.push({ t: "vline", x, y1: 0, y2: h, ...border }));
      const cut = r === 0 ? undefined : r === 1 ? { score: 0, clean: false } : { score: 0.5, clean: !ctx.quote };
      const row = pushRow(h, ops, { decos: ctx.decos, cut });
      if (r === 0) headerRow = row;
      // A page that starts inside the table draws its header row again first.
      else if (headerRow && r > 1) {
        row.repeat = { h: headerRow.h, ops: headerRow.ops.concat([{ t: "line", x1: ctx.x, x2: ctx.x + tableW, y: 0, ...border }]) };
        if (row.cut) row.cut.extra = headerRow.h;
      }
    });
  }

  layoutBlocks(blocks, { x: 0, width: g.columnWidth, top: true, decos: [] }, 0);
  const height = rows.length ? rows[rows.length - 1].y + rows[rows.length - 1].h : 0;
  return { rows, headings, anchors, height, width: g.columnWidth, geometry: g, options: o };
}

function shiftOp(op, dy) {
  if (!dy) return op;
  const out = { ...op };
  if ("y" in out) out.y += dy;
  if ("y1" in out) { out.y1 += dy; out.y2 += dy; }
  return out;
}

// Code text → lines of coloured pieces. `tokens` is Prism's token stream
// flattened to [{ text, type }] (or null for plain).
export function splitCodeLines(text, tokens) {
  const flat = tokens && tokens.length ? tokens : [{ text, type: "" }];
  const lines = [[]];
  for (const token of flat) {
    const colour = CODE_COLOURS[token.type] || null;
    const parts = String(token.text).split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, colour });
    });
  }
  // A trailing newline is not an empty last line.
  if (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  return lines;
}

// Prism's nested token stream, flattened to [{ text, type }] with the
// innermost meaningful type (src/render uses the same Prism the page loads).
export function flattenPrismTokens(stream, type = "") {
  const out = [];
  for (const token of stream || []) {
    if (typeof token === "string") out.push({ text: token, type });
    else {
      const inner = Array.isArray(token.content) ? token.content : [token.content];
      const own = CODE_COLOURS[token.type] ? token.type : (Array.isArray(token.alias) ? token.alias : [token.alias]).find((a) => CODE_COLOURS[a]) || type;
      out.push(...flattenPrismTokens(inner, own));
    }
  }
  return out;
}
