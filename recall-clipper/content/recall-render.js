// Recall Clipper — faithful port of the Recall app's Markdown rendering pipeline.
//
// The whole point of this file is fidelity: the preview must render exactly what
// a Recall deck will show once the clipped Markdown is pasted in. Every function
// below is ported (near-verbatim) from Recall's app.js so the two stay in step —
// same `marked` options, same preprocessing (cloze, image rows, math, mermaid /
// nomnoml fences), same DOMPurify allow-list, and the same post-render enhance
// pass (KaTeX, Prism, mermaid, nomnoml, Google-Drive image URLs).
//
// Depends on globals that the background worker injects first: marked, DOMPurify
// (always) and, once the preview needs them, katex, renderMathInElement, Prism,
// mermaid, nomnoml. Anything not yet loaded is guarded with typeof so rendering
// degrades gracefully instead of throwing.
//
// PORT ANCHORS — line numbers in app.js at the time of writing. Anything changed
// on one side has to be changed on the other, or the preview starts lying about
// what a deck will show, which is the one thing this file exists to prevent:
//
//   escapeHtml 8392 · encodeAttribute 8401 · isEscaped 8405
//   isSingleDollarLine 8417 · findSingleDollarLine 8440 · findUnescaped 8447
//   canOpenInlineDollar 8454 · INLINE_MATH_MAX_SPAN/findInlineDollarClose 8471
//   healEscapedTex 8518 · mathNode 8548 · normalizeDisplayMathIndentation 8554
//   protectMath 8566 · applyClozeMarkup 8768 · protectInline 8794
//   renderImageRows 8864 · normalizeCitations 8894 · parseDiagramWidth 8938
//   diagramOpenTag 8956 · preprocessSpecialBlocks 8962 · normalizeImageUrl 8990
//   SANITIZE_CONFIG 8999 · enhanceRenderedMarkdown 9334
//   markdownTableColumnCount 9941 · applyMarkdownTableColumns 9955
//   markdownTableHeaderCells 9992 · applyMarkdownTableLabels 10006
//   wrapMarkdownTable 10027
//
// Not ported, deliberately: fitMarkdownTableFont (app.js:10048) binary-searches
// a font size against Recall's own CSS variables and layout, which don't exist
// on an arbitrary page; and promoteNotesHeadings (app.js:9460), which only
// applies to the notes surface, not to a fragment.
(function () {
  "use strict";
  if (window.__recallRender) return; // idempotent — re-injection is a no-op

  // marked matches Recall's global setOptions() exactly.
  if (typeof marked !== "undefined" && marked.setOptions) {
    marked.setOptions({ breaks: true, gfm: true, mangle: false, headerIds: false });
  }

  const codeLanguageAliases = {
    cjs: "javascript", coffee: "coffeescript", "c++": "cpp", "c#": "csharp",
    "f#": "fsharp", html: "markup", js: "javascript", jsx: "javascript",
    mjs: "javascript", md: "markdown", py: "python", rb: "ruby", sh: "bash",
    shell: "bash", tex: "latex", ts: "typescript", tsx: "typescript", yml: "yaml"
  };

  // ── Escaping ────────────────────────────────────────────────────────────
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  function encodeAttribute(value) { return escapeHtml(encodeURIComponent(value)); }

  // ── Math protection (LaTeX → placeholder nodes rendered later by KaTeX) ───
  function isEscaped(source, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
      slashes += 1;
    }
    return slashes % 2 === 1;
  }
  // Whitespace that is not a line break — i.e. a line's own indentation.
  const LINE_SPACE_RE = /[^\S\n]/;

  function isSingleDollarLine(source, index) {
    if (source[index] !== "$" || source[index - 1] === "$" || source[index + 1] === "$" || isEscaped(source, index)) {
      return false;
    }
    // Stepping over the line's own spaces, rather than lastIndexOf("\n") +
    // slice + trim: the backward search scans to the start of the document
    // whenever there is no newline above, which is quadratic on a note written
    // as one very long line. Same reasoning as app.js.
    let before = index - 1;
    while (before >= 0 && LINE_SPACE_RE.test(source[before])) before -= 1;
    if (before >= 0 && source[before] !== "\n") return false;

    let after = index + 1;
    while (after < source.length && LINE_SPACE_RE.test(source[after])) after += 1;
    return after >= source.length || source[after] === "\n";
  }
  function findSingleDollarLine(source, start) {
    for (let index = source.indexOf("$", start); index !== -1; index = source.indexOf("$", index + 1)) {
      if (isSingleDollarLine(source, index)) return index;
    }
    return -1;
  }
  function findUnescaped(source, token, start) {
    for (let index = source.indexOf(token, start); index !== -1; index = source.indexOf(token, index + token.length)) {
      if (!isEscaped(source, index)) return index;
    }
    return -1;
  }
  function canOpenInlineDollar(source, index) {
    const next = source[index + 1];
    return next && next !== "$" && !/\s/.test(next) && !isEscaped(source, index);
  }
  // How far an inline $…$ span may reach, and no further than the end of its
  // paragraph. Without both bounds, prose that mentions money is silently eaten
  // and the scan goes quadratic. See app.js for the measured numbers.
  const INLINE_MATH_MAX_SPAN = 1000;

  function findInlineDollarClose(source, start) {
    let limit = Math.min(source.length, start + INLINE_MATH_MAX_SPAN);
    for (let at = start; at < limit - 1; at += 1) {
      if (source[at] === "\n" && source[at + 1] === "\n") { limit = at; break; }
    }
    for (let index = source.indexOf("$", start); index !== -1 && index < limit; index = source.indexOf("$", index + 1)) {
      const previous = source[index - 1];
      if (source[index + 1] !== "$" && previous && !/\s/.test(previous) && !isEscaped(source, index)) {
        return index;
      }
    }
    return -1;
  }

  // Undoes Markdown backslash-escaping that got baked into a formula, so a
  // clip whose math reached us as "x\_k" or "\\frac" still previews correctly.
  // Delegated to recall-math.js, which owns the ported copy.
  function healEscapedTex(tex) {
    return window.__recallMath ? window.__recallMath.healEscapedTex(tex) : tex;
  }

  function mathNode(tex, displayMode) {
    const tag = displayMode ? "div" : "span";
    const className = displayMode ? "math-display" : "math-inline";
    return `<${tag} class="${className}" data-tex="${encodeAttribute(healEscapedTex(tex.trim()))}"></${tag}>`;
  }
  function normalizeDisplayMathIndentation(markdown) {
    return markdown
      .replace(/(^|\n)[ \t]{4,}\$\$[ \t]*\n([\s\S]*?)\n[ \t]{4,}\$\$[ \t]*(?=\n|$)/g, (match, prefix, tex) => {
        const normalizedTex = tex
          .split("\n")
          .map((line) => line.replace(/^[ \t]{4}/, ""))
          .join("\n");
        return `${prefix}$$\n${normalizedTex}\n$$`;
      })
      .replace(/(^|\n)[ \t]{4,}\$\$([^\n]+?)\$\$[ \t]*(?=\n|$)/g, "$1$$$$$2$$$$");
  }
  function protectMath(markdown) {
    let output = "";
    let index = 0;
    const source = normalizeDisplayMathIndentation(markdown);
    while (index < source.length) {
      if (source.startsWith("$$", index) && !isEscaped(source, index)) {
        const close = findUnescaped(source, "$$", index + 2);
        if (close !== -1) {
          const node = mathNode(source.slice(index + 2, close), true);
          const needsLeading = output.length > 0 && !output.endsWith("\n\n");
          output += (needsLeading ? "\n\n" : "") + node + "\n\n";
          index = close + 2;
          while (index < source.length && source[index] === "\n") index++;
          continue;
        }
      }
      if (isSingleDollarLine(source, index)) {
        const openLineEnd = source.indexOf("\n", index);
        const contentStart = openLineEnd === -1 ? index + 1 : openLineEnd + 1;
        const close = findSingleDollarLine(source, contentStart);
        if (close !== -1) {
          const closeLineStart = source.lastIndexOf("\n", close - 1) + 1;
          const node = mathNode(source.slice(contentStart, closeLineStart), true);
          const needsLeading = output.length > 0 && !output.endsWith("\n\n");
          output += (needsLeading ? "\n\n" : "") + node + "\n\n";
          const closeLineEnd = source.indexOf("\n", close);
          index = closeLineEnd === -1 ? close + 1 : closeLineEnd + 1;
          while (index < source.length && source[index] === "\n") index++;
          continue;
        }
      }
      // A literal "[" immediately before "\[" is Markdown's escaped-bracket
      // syntax for brackets inside link text — Turndown emits "[\[1\]](url)"
      // for a citation marker. Never a LaTeX delimiter someone typed.
      const precededByLinkBracket = index > 0 && source[index - 1] === "[" && !isEscaped(source, index - 1);
      if (!precededByLinkBracket && (source.startsWith("\\[", index) || source.startsWith("\\(", index)) && !isEscaped(source, index)) {
        const displayMode = source[index + 1] === "[";
        const closeToken = displayMode ? "\\]" : "\\)";
        const close = findUnescaped(source, closeToken, index + 2);
        // "\[text\](url)" is Markdown's escaped-bracket link syntax — the ONE
        // shape relaxEscapedBrackets leaves escaped. Display math is never
        // immediately followed by "(", so declining it costs nothing.
        const followsAsLink = close !== -1 && displayMode && source[close + 2] === "(";
        if (close !== -1 && !followsAsLink) {
          const node = mathNode(source.slice(index + 2, close), displayMode);
          if (displayMode) {
            const needsLeading = output.length > 0 && !output.endsWith("\n\n");
            output += (needsLeading ? "\n\n" : "") + node + "\n\n";
          } else {
            output += node;
          }
          index = close + 2;
          continue;
        }
      }
      if (source[index] === "$" && canOpenInlineDollar(source, index)) {
        const close = findInlineDollarClose(source, index + 1);
        if (close !== -1) {
          output += mathNode(source.slice(index + 1, close), false);
          index = close + 1;
          continue;
        }
      }
      // Nothing at `index` opens math, and every branch above needs a "$" or a
      // "\" right here, so copy the whole run up to the next one in a single go
      // rather than a character per iteration.
      let next = index + 1;
      while (next < source.length && source[next] !== "$" && source[next] !== "\\") next += 1;
      output += source.slice(index, next);
      index = next;
    }
    return output;
  }

  // ── Cloze + inline transforms (skip inline code spans) ────────────────────
  function applyClozeMarkup(text) {
    return String(text).replace(
      /\{\{([\s\S]+?)\}\}/g,
      (_match, inner) => `<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">${inner}</span>`
    );
  }
  // Cloze and code-span detection can't run as two independent passes —
  // whichever delimiter the author opened FIRST has to win: "{{`SELECT`}}"
  // clozes a code term, while "`{{x}}`" documents literal cloze syntax as code.
  // This scans left to right and lets whichever token starts earlier consume its
  // full span.
  function protectInline(segment) {
    let output = "";
    let i = 0;
    const len = segment.length;

    while (i < len) {
      const clozeStart = segment.indexOf("{{", i);
      // indexOf, never segment.slice(i) + regex. Slicing copied the WHOLE
      // remaining document on every iteration and then scanned that copy, so a
      // note with k code spans cost O(n·k) — measured quadratic in app.js
      // (200KB → 5ms, 1MB → 64ms, 2MB → 250ms).
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
          output += protectMath(applyClozeMarkup(segment.slice(i, codeStart)));
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
          output += protectMath(applyClozeMarkup(segment.slice(i, clozeStart)));
          const inner = segment.slice(clozeStart + 2, closeIdx);
          output += `<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">${protectMath(inner)}</span>`;
          i = closeIdx + 2;
          continue;
        }
      }

      // Neither a valid code span nor a valid cloze from here on — process
      // whatever's left as plain text and stop.
      output += protectMath(applyClozeMarkup(segment.slice(i)));
      break;
    }
    return output;
  }

  // ── Side-by-side image rows (`![](a) | ![](b)`) ───────────────────────────
  const IMG_TOKEN_SOURCE = "!\\[[^\\]]*\\]\\([^)]*\\)|<img\\b[^>]*>";
  function imageMarkupToTag(token) {
    const md = token.trim().match(/^!\[([^\]]*)\]\(([^)]*)\)$/);
    if (md) return `<img src="${escapeHtml(md[2].trim())}" alt="${escapeHtml(md[1])}">`;
    if (/^<img\b[^>]*>$/i.test(token.trim())) return token.trim();
    return "";
  }
  function renderImageRows(segment) {
    const lineRe = new RegExp(
      `^[^\\S\\n]*(?:${IMG_TOKEN_SOURCE})(?:[^\\S\\n]*\\|[^\\S\\n]*(?:${IMG_TOKEN_SOURCE}))+[^\\S\\n]*$`,
      "gm"
    );
    const imgRe = new RegExp(IMG_TOKEN_SOURCE, "gi");
    return segment.replace(lineRe, (line) => {
      const imgs = (line.match(imgRe) || []).map(imageMarkupToTag).filter(Boolean);
      if (imgs.length < 2) return line;
      return `<div class="notes-img-row">${imgs.join("")}</div>`;
    });
  }

  // ── Citation / footnote normalisation ─────────────────────────────────────
  // Turndown turns a citation marker into "[\[1\]](#fn1)" — backslashes and a
  // dead anchor. The clipper fixes most of these at capture time, but a clip can
  // still carry the shape (and pasted notes certainly do), so the renderer
  // normalises the same shapes to a clean inline `[1]`, exactly as a deck does.
  const CITE_INNER = "\\d+[a-z]?(?:\\s*[-\\u2013\\u2014,;]\\s*\\d+[a-z]?)*";
  const CITE_HREF_FRAG = "#(?:fn|fnref|cite|ref|reference|footnote|note|endnote|_?ftn)";
  const CITATION_LINK_RE = new RegExp(
    "\\[\\s*\\\\?\\[?\\s*(" + CITE_INNER + ")\\s*\\\\?\\]?\\s*\\]\\(" + CITE_HREF_FRAG + "[^)]*\\)",
    "gi"
  );
  const CITATION_ESCAPED_RE = new RegExp("\\\\\\[(\\s*" + CITE_INNER + "\\s*)\\\\\\]", "gi");
  const FOOTNOTE_BACKREF_LINK_RE = /\[[↩↵⮐︎\s]*\]\(#[^)]*\)/g;
  const FOOTNOTE_BACKREF_ARROW_RE = /[↩↵⮐]︎?/g;

  function normalizeCitations(text) {
    return String(text)
      .replace(CITATION_LINK_RE, "[$1]")
      .replace(CITATION_ESCAPED_RE, "[$1]")
      .replace(FOOTNOTE_BACKREF_LINK_RE, "")
      .replace(FOOTNOTE_BACKREF_ARROW_RE, "");
  }

  // ── Diagram sizing ────────────────────────────────────────────────────────
  // A resized diagram is stored as ```mermaid w=520 — the info string is the
  // only place a fenced block has to hang an attribute. Without this the
  // preview drew every diagram full width while a deck drew it at 520px.
  const DIAGRAM_WIDTH_MIN = 80;
  const DIAGRAM_WIDTH_MAX = 4000;

  function parseDiagramWidth(info) {
    const match = String(info || "").match(/\b(?:w|width)\s*=\s*(\d{2,4})\b/i);
    if (!match) return null;
    const px = parseInt(match[1], 10);
    if (!Number.isFinite(px)) return null;
    return Math.min(DIAGRAM_WIDTH_MAX, Math.max(DIAGRAM_WIDTH_MIN, px));
  }

  function diagramOpenTag(className, info) {
    const px = parseDiagramWidth(info);
    if (!px) return `<div class="${className}"`;
    return `<div class="${className} has-custom-size" style="--notes-img-w:${px}px; width:${px}px"`;
  }

  // ── Fence extraction (mermaid / nomnoml → diagram divs, rest kept) ────────
  function normalizeMarkdown(text) {
    return String(text || "").replace(/\r\n?/g, "\n").replace(/ /g, " ");
  }
  function preprocessSpecialBlocks(markdown) {
    const source = normalizeMarkdown(markdown || "");
    const fencePattern = /```[ \t]*([^\n]*)\n([\s\S]*?)```/g;
    let output = "";
    let lastIndex = 0;
    let match;
    while ((match = fencePattern.exec(source))) {
      output += protectInline(renderImageRows(normalizeCitations(source.slice(lastIndex, match.index))));
      if (/\bmermaid\b/i.test(match[1])) {
        output += `${diagramOpenTag("mermaid", match[1])} data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
      } else if (/\bnomnoml\b/i.test(match[1])) {
        output += `${diagramOpenTag("nomnoml-diagram", match[1])} data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
      } else {
        output += match[0];
      }
      lastIndex = fencePattern.lastIndex;
    }
    output += protectInline(renderImageRows(normalizeCitations(source.slice(lastIndex))));
    return output;
  }

  // ── Google-Drive share links → embeddable image URLs ─────────────────────
  function normalizeImageUrl(url) {
    if (!url) return url;
    const m = String(url).match(
      /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^&]*&)*id=|thumbnail\?(?:[^&]*&)*id=)([\w-]{20,})/
    );
    if (!m) return url;
    return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
  }

  // ── Markdown → sanitized HTML (matches Recall's markdownToSafeHtml) ───────
  // Byte-for-byte Recall's SANITIZE_CONFIG. The ALLOWED_URI_REGEXP was missing
  // here, which meant the preview fell back to DOMPurify's default allowlist and
  // stripped `recall-img:` — an image pasted into a deck while offline showed in
  // a deck and vanished in the preview, for no reason the user could see.
  const SANITIZE_CONFIG = {
    ADD_TAGS: ["foreignObject", "font", "u", "del", "kbd"],
    ADD_ATTR: ["target", "rel", "class", "data-tex", "data-diagram", "style", "color", "face", "tabindex", "role", "aria-label"],
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|recall-img):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  };

  function markdownToSafeHtml(md) {
    const prepared = preprocessSpecialBlocks(md || "");
    const html = marked.parse(prepared);
    return DOMPurify.sanitize(html, SANITIZE_CONFIG);
  }

  // ── Code highlighting (Prism) ─────────────────────────────────────────────
  function declaredCodeLanguage(code) {
    const cls = Array.from(code.classList).find((c) => c.startsWith("language-"));
    return cls ? cls.replace(/^language-/, "").trim() : "";
  }
  function normalizeCodeLanguage(language) {
    const normalized = String(language || "").toLowerCase();
    return codeLanguageAliases[normalized] || normalized;
  }
  function codeLanguageLabel(language) {
    return language.replace(/^language-/, "").replace(/[-_]+/g, " ").trim().toUpperCase();
  }
  let prismPythonConfigured = false;
  function configurePrismLanguages() {
    if (prismPythonConfigured || !window.Prism || !window.Prism.languages || !window.Prism.languages.python) return;
    Prism.languages.insertBefore("python", "function", {
      method: { pattern: /(\.)[A-Za-z_]\w*(?=\s*\()/, lookbehind: true },
      "uppercase-constant": /\b[A-Z][A-Z0-9_]*\b/
    });
    prismPythonConfigured = true;
  }
  function enhanceCodeBlocks(container) {
    if (window.Prism && Prism.plugins && Prism.plugins.autoloader) {
      Prism.plugins.autoloader.languages_path = "https://cdn.jsdelivr.net/npm/prismjs@1.30.0/components/";
    }
    configurePrismLanguages();
    container.querySelectorAll("pre code").forEach((code) => {
      const pre = code.closest("pre");
      const declared = declaredCodeLanguage(code);
      const normalized = normalizeCodeLanguage(declared);
      pre?.classList.add("code-block");
      if (declared && pre) {
        pre.classList.add("has-code-language");
        pre.dataset.language = codeLanguageLabel(declared);
      }
      if (!window.Prism || !normalized || code.dataset.highlighted === "yes") return;
      code.classList.add(`language-${normalized}`);
      pre?.classList.add(`language-${normalized}`);
      try { Prism.highlightElement(code); } catch (_) { /* leave plain */ }
    });
  }

  // ── Post-render enhancement (KaTeX / Prism / mermaid / nomnoml / images) ──
  async function enhanceRenderedMarkdown(container) {
    container.querySelectorAll("a[href]").forEach((link) => {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });

    enhanceCodeBlocks(container);

    if (typeof katex !== "undefined") {
      container.querySelectorAll(".math-display[data-tex], .math-inline[data-tex]").forEach((node) => {
        try {
          katex.render(decodeURIComponent(node.dataset.tex), node, {
            displayMode: node.classList.contains("math-display"),
            throwOnError: false
          });
        } catch (_) {
          node.textContent = decodeURIComponent(node.dataset.tex);
        }
      });
      // Safety net for delimiters protectMath declined. "$…$" is deliberately
      // NOT in this list — protectMath owns every dollar span, with rules about
      // currency that auto-render does not have, and letting KaTeX have a second
      // pass at them made the preview render money as math where a deck (which
      // runs the same net without "$") rendered it as money. Same list as
      // app.js.
      if (typeof renderMathInElement === "function") {
        try {
          renderMathInElement(container, {
            delimiters: [
              { left: "\\[", right: "\\]", display: true },
              { left: "\\(", right: "\\)", display: false }
            ],
            throwOnError: false
          });
        } catch (_) { /* ignore */ }
      }
    }

    if (typeof mermaid !== "undefined") {
      const diagrams = container.querySelectorAll(".mermaid");
      diagrams.forEach((node) => {
        if (node.dataset.diagram) node.textContent = decodeURIComponent(node.dataset.diagram);
        node.removeAttribute("data-processed");
      });
      if (diagrams.length) {
        try { await mermaid.run({ nodes: diagrams }); }
        catch (error) { console.warn("Recall Clipper: mermaid render failed", error); }
      }
    }

    if (typeof nomnoml !== "undefined") {
      container.querySelectorAll(".nomnoml-diagram").forEach((node) => {
        if (node.dataset.diagram) node.textContent = decodeURIComponent(node.dataset.diagram);
        try {
          const svg = nomnoml.renderSvg(node.textContent);
          node.innerHTML = svg;
        } catch (err) {
          node.textContent = "Error rendering Nomnoml: " + err.message;
        }
      });
    }

    container.querySelectorAll("img").forEach((img) => {
      const rewritten = normalizeImageUrl(img.getAttribute("src"));
      if (rewritten !== img.getAttribute("src")) img.setAttribute("src", rewritten);
    });

    fitMarkdownTables(container);
  }

  // ── Table post-processing ─────────────────────────────────────────────────
  // A deck never renders a bare <table>: it wraps it for horizontal scroll,
  // stamps every cell with its column's header (the mobile stacked layout reads
  // those back) and injects a <colgroup> of proportional widths. Without this
  // the preview showed evenly-divided columns and a deck showed weighted ones,
  // so a table always looked different in the two places.
  //
  // fitMarkdownTableFont (app.js:10048) is deliberately not ported — it binary-
  // searches a font size against Recall's own CSS variables and page layout,
  // neither of which exists on an arbitrary web page.
  function markdownTableColumnCount(table) {
    return Array.from(table.rows).reduce((max, row) => {
      const count = Array.from(row.cells).reduce((sum, cell) => sum + Math.max(1, cell.colSpan || 1), 0);
      return Math.max(max, count);
    }, 0);
  }

  function tableCellWeight(cell) {
    const text = String(cell.textContent || "").replace(/\s+/g, " ").trim();
    const longestWord = text.split(/\s+/).reduce((max, word) => Math.max(max, word.length), 0);
    return Math.max(4, Math.min(80, text.length * 0.58 + longestWord * 0.9));
  }

  function applyMarkdownTableColumns(table) {
    const columnCount = markdownTableColumnCount(table);
    if (!columnCount) return;
    table.style.setProperty("--markdown-table-columns", String(columnCount));

    const weights = Array(columnCount).fill(4);
    Array.from(table.rows).forEach((row) => {
      let columnIndex = 0;
      Array.from(row.cells).forEach((cell) => {
        const span = Math.max(1, cell.colSpan || 1);
        const weight = tableCellWeight(cell) / span;
        for (let offset = 0; offset < span && columnIndex + offset < weights.length; offset += 1) {
          weights[columnIndex + offset] = Math.max(weights[columnIndex + offset], weight);
        }
        columnIndex += span;
      });
    });

    table.querySelector(":scope > colgroup")?.remove();
    const colgroup = document.createElement("colgroup");
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    weights.forEach((weight) => {
      const col = document.createElement("col");
      col.style.width = `${(weight / total) * 100}%`;
      colgroup.appendChild(col);
    });
    table.insertBefore(colgroup, table.firstChild);
  }

  function markdownTableHeaderCells(table) {
    if (table.tHead?.rows.length) {
      return Array.from(table.tHead.rows[table.tHead.rows.length - 1].cells);
    }
    return Array.from(table.rows)
      .find((row) => Array.from(row.cells).some((cell) => cell.tagName === "TH"))
      ?.cells || [];
  }

  function markdownTableHeaders(table) {
    const labels = [];
    Array.from(markdownTableHeaderCells(table)).forEach((cell) => {
      const label = String(cell.textContent || "").replace(/\s+/g, " ").trim();
      const span = Math.max(1, cell.colSpan || 1);
      for (let index = 0; index < span; index += 1) {
        labels.push(label || `Column ${labels.length + 1}`);
      }
    });
    return labels;
  }

  function applyMarkdownTableLabels(table) {
    const labels = markdownTableHeaders(table);
    const columnCount = markdownTableColumnCount(table);
    while (labels.length < columnCount) {
      labels.push(`Column ${labels.length + 1}`);
    }
    if (!labels.length) return;

    const headerCells = new Set(Array.from(markdownTableHeaderCells(table)));
    Array.from(table.rows).forEach((row) => {
      let columnIndex = 0;
      Array.from(row.cells).forEach((cell) => {
        const span = Math.max(1, cell.colSpan || 1);
        if (!headerCells.has(cell)) {
          cell.dataset.label = labels[columnIndex] || `Column ${columnIndex + 1}`;
        }
        columnIndex += span;
      });
    });
  }

  function wrapMarkdownTable(table) {
    if (table.parentElement?.classList.contains("markdown-table-wrap")) return table.parentElement;
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-wrap";
    table.parentNode.insertBefore(wrapper, table);
    wrapper.appendChild(table);
    return wrapper;
  }

  function fitMarkdownTables(container) {
    container.querySelectorAll("table").forEach((table) => {
      if (table.closest("pre")) return;
      wrapMarkdownTable(table);
      applyMarkdownTableLabels(table);
      applyMarkdownTableColumns(table);
    });
  }

  // Initialise mermaid once, mirroring Recall's strict-security defaults.
  function initMermaid() {
    if (typeof mermaid === "undefined" || window.__rcMermaidInit) return;
    try {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
      window.__rcMermaidInit = true;
    } catch (_) { /* ignore */ }
  }

  window.__recallRender = { markdownToSafeHtml, enhanceRenderedMarkdown, initMermaid };
})();
