// HTML -> markdown, for pasting from a web page or another app.

import { ensureTurndown } from "../core/lib-loader.js?v=__BUILD__";
import { MARK_CLOSE_TAG, markOpenTag } from "../format/highlight.js?v=__BUILD__";
import { RAW_MATH_ATTR, protectMathInDom, relaxEscapedBrackets } from "../render/math-dom.js?v=__BUILD__";
import { repairEscapedMathMarkdown } from "../render/math.js?v=__BUILD__";
import { mathmlToTex, sanitizeMathTex } from "./mathml-to-tex.js?v=__BUILD__";

// Shared HTML→Markdown converter (paste handler + notes selection capture).
// Returns "" when Turndown is unavailable or conversion fails.
// A configured TurndownService per option combination, built once.
//
// The whole setup below — the GFM plugin plus ~15 custom rules — used to be
// rebuilt on EVERY call, and htmlToMarkdown is called from
// positionNotesSelectionButton, i.e. every 160ms while a selection is being
// dragged. The rules are pure functions of the two option flags, so there are
// only a handful of distinct services and they can simply be kept.
export const turndownServices = new Map();

export function turndownServiceFor(options) {
  const key = `${options.preserveInlineStyles ? 1 : 0}:${options.epubMode ? 1 : 0}`;
  let service = turndownServices.get(key);
  if (!service) {
    service = buildTurndownService(options);
    turndownServices.set(key, service);
  }
  return service;
}

export function htmlToMarkdown(html, options = {}) {
  // Synchronous by contract — its callers run inside paste and selection
  // handlers that cannot await. turndown loads on demand (ensureTurndown) and
  // is warmed at idle right after boot, so in practice it is always here by
  // the time a human has selected or pasted anything. In the window where it
  // isn't, this returns "" exactly as it did before and every caller already
  // falls back to plain text; kick off the load so the next attempt works.
  if (typeof TurndownService === "undefined") {
    ensureTurndown();
    return "";
  }
  const turndownService = turndownServiceFor(options);
  return turndownWithService(turndownService, html, options);
}

// What kind of math a leading element is, for the adjacency guard below:
// MathML itself, the app's own rendered math spans, pre-rendered KaTeX from a
// paste, and protectMathInDom's placeholders.
function mathKindOf(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.nodeName.toLowerCase() === "math") {
    return el.getAttribute("display") === "block" ? "display" : "inline";
  }
  if (el.classList) {
    if (el.classList.contains("math-display") || el.classList.contains("katex-display")) return "display";
    if (el.classList.contains("math-inline") || el.classList.contains("katex")) return "inline";
  }
  if (el.hasAttribute(RAW_MATH_ATTR)) {
    const tex = el.getAttribute(RAW_MATH_ATTR) || "";
    return tex.startsWith("$$") || tex.startsWith("\\[") ? "display" : "inline";
  }
  return null;
}

// True when the very next thing the conversion will emit after this math node
// is ANOTHER inline math span — i.e. this rule's "$…$" would run straight
// into the next one's with no text between. That makes "$=$$12$", and
// protectMath reads the "$$" as a display-math opener, swallowing the prose
// after it — the whole-paragraph corruption math-heavy EPUBs hit, whose
// converter emits adjacent <span class="math-inline">…</span><span class=
// "math-inline"> with no whitespace between (Wikipedia does the same). The
// rules below keep the two formulas a space apart. A display follower needs
// nothing: it starts with newlines.
export function followedByInlineMath(node) {
  let host = node;
  // Climb out of plain inline wrappers (Nougat's span.math-inline, Wikipedia's
  // mwe-math spans) while this node is their last meaningful child — the
  // question is what follows the OUTERMOST one.
  for (;;) {
    const parent = host.parentNode;
    if (!parent || parent.nodeName !== "SPAN") break;
    let sib = host.nextSibling;
    while (sib && sib.nodeType === 3 && !sib.textContent.trim()) sib = sib.nextSibling;
    if (sib) break; // not the last meaningful child — answer at this level
    host = parent;
  }
  let sib = host.nextSibling;
  while (sib && sib.nodeType === 3 && !sib.textContent.trim()) sib = sib.nextSibling;
  if (!sib || sib.nodeType !== 1) return false;
  // The sibling's leading element chain must reach a math element before any
  // text — <span class="math-inline"><math>…, or the app's own math span.
  let lead = sib;
  for (;;) {
    const kind = mathKindOf(lead);
    if (kind) return kind === "inline";
    let child = lead.firstChild;
    while (child && child.nodeType === 3 && !child.textContent.trim()) child = child.nextSibling;
    if (!child || child.nodeType !== 1) return false;
    lead = child;
  }
}

export function buildTurndownService(options = {}) {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    hr: "---",
    bulletListMarker: "-"
  });

  // Load GFM plugin for tables, strikethrough, etc. if available
  if (typeof turndownPluginGfm !== "undefined" && turndownPluginGfm.gfm) {
    turndownService.use(turndownPluginGfm.gfm);
  }

  const escapeMarkdown = turndownService.escape.bind(turndownService);
  turndownService.escape = (string) => relaxEscapedBrackets(escapeMarkdown(string));

  // Emits the LaTeX protectMathInDom lifted out of the DOM, exactly as the
  // source wrote it. Display math keeps its own blank lines so it survives as a
  // block (protectMath's normalizeDisplayMathIndentation handles the 4-space
  // indent Turndown adds when the block sits inside a list item).
  turndownService.addRule("raw-math", {
    filter: (node) => node.nodeName === "SPAN" && node.hasAttribute && node.hasAttribute(RAW_MATH_ATTR),
    replacement: (content, node) => {
      const tex = node.getAttribute(RAW_MATH_ATTR);
      const isDisplay = tex.startsWith("$$") || tex.startsWith("\\[");
      return isDisplay ? `\n\n${tex}\n\n` : tex;
    }
  });

  // <mark> carries its colour as data-color (see MARK_HIGHLIGHT_COLORS) and,
  // optionally, a reference to a note as data-note — an id whose text lives in
  // the "Highlight Notes" section of the note it came from (see
  // format/highlight-notes.js). The reference rides along so a highlight copied
  // and pasted back into the SAME note keeps its note; pasted into a different
  // one it resolves to nothing, which reads as an un-annotated highlight
  // rather than an error. The
  // generic keep-tag loop below would drop both, so a copied highlight would
  // always turn yellow (or lose the highlight/note entirely) on the far side
  // regardless of what it actually was. Unlike the preserveInlineStyles-gated
  // rules below, this one is unconditional: a highlight is this app's own
  // semantic markup, not web/Office style noise, so it must survive being
  // copied and pasted anywhere in the app (including the general clipboard-
  // paste path), not just the notes-selection path.
  turndownService.addRule("keep-mark", {
    filter: (node) => node.nodeName === "MARK",
    replacement: (content, node) => {
      const color = node.getAttribute("data-color");
      const note = node.getAttribute("data-note");
      return `${markOpenTag(color, note)}${content}${MARK_CLOSE_TAG}`;
    }
  });

  // Notes carry inline styling as raw HTML — colored/font-family text
  // (`<span style="…">` from the toolbar's color/font pickers), underline
  // (`<u>`) and keyboard keys (`<kbd>`). Turndown drops these by default,
  // keeping only the text, so a card made from a styled notes selection lost
  // its color/font/underline. When preserveInlineStyles is set (the notes-
  // selection path), re-emit them so the styling survives into the card
  // exactly as it looked in the notes. This is intentionally NOT enabled for
  // the general clipboard-paste path, where preserving every web/Office
  // `<span style>` would just litter pasted markdown.
  if (options.preserveInlineStyles) {
    turndownService.addRule("styled-span", {
      filter: (node) =>
        node.nodeName === "SPAN" &&
        node.getAttribute("style") &&
        /(?:^|;)\s*(?:color|font-family|background-color|background)\s*:/i.test(node.getAttribute("style")),
      replacement: (content, node) => `<span style="${node.getAttribute("style")}">${content}</span>`
    });
    [
      ["u", "U"],
      ["kbd", "KBD"]
    ].forEach(([tag, nodeName]) => {
      turndownService.addRule(`keep-${tag}`, {
        filter: (node) => node.nodeName === nodeName,
        replacement: (content) => `<${tag}>${content}</${tag}>`
      });
    });

    // A rendered mermaid/nomnoml diagram is an <svg>, which carries no usable
    // text for Turndown's generic element handling to fall back on — a
    // selection spanning one used to come out empty or as jumbled label
    // fragments. preprocessSpecialBlocks stashes the original fence source,
    // URL-encoded, in data-diagram on this exact node (and never clears it —
    // renderDiagramNodes re-reads it on every re-render), so recover it here
    // instead of serializing the SVG, the same way notesSelectionCodeFence
    // recovers a code block's source ahead of the generic path.
    turndownService.addRule("keep-diagram-source", {
      filter: (node) =>
        node.nodeName === "DIV" &&
        (node.classList.contains("mermaid") || node.classList.contains("nomnoml-diagram")) &&
        Boolean(node.dataset.diagram),
      replacement: (content, node) => {
        const lang = node.classList.contains("mermaid") ? "mermaid" : "nomnoml";
        let source = "";
        try {
          source = decodeURIComponent(node.dataset.diagram);
        } catch (err) {
          source = "";
        }
        return source ? `\n\n\`\`\`${lang}\n${source}\n\`\`\`\n\n` : "";
      }
    });
  }

  // App clozes render as <span class="cloze">…</span>. Turn them back into
  // {{…}} so a card (or note) built from a selection that includes a cloze
  // keeps the fill-in-the-blank instead of flattening it to plain text. The
  // inner content is converted first, so a cloze wrapping bold/math/an image
  // round-trips as {{**ATP**}}, {{$x$}}, {{![](url)}} etc. Added unconditionally
  // (not gated on preserveInlineStyles): .cloze is our own class, so pasted web
  // HTML never carries it, and any Recall content copied as HTML should keep it.
  turndownService.addRule("cloze", {
    filter: (node) =>
      node.nodeName === "SPAN" && node.classList && node.classList.contains("cloze"),
    replacement: (content) => {
      const inner = content.trim();
      return inner ? `{{${inner}}}` : "";
    }
  });

  // Rendered math is a tree of KaTeX glyph spans — nothing Turndown's generic
  // handling can make sense of, exactly like the mermaid SVG above. And exactly
  // like mermaid, the original source is already stashed on the node:
  // preprocessSpecialBlocks writes the URL-encoded TeX to data-tex on this host
  // and katex.render only ever replaces its CHILDREN, so the attribute survives
  // every re-render. Read it instead of serializing the glyphs.
  //
  // Registered unconditionally (like the cloze rule above, unlike the diagram
  // one): .math-inline/.math-display are our own markup, so pasted web HTML
  // never carries them, and Recall content copied as HTML should keep its math.
  turndownService.addRule("math-source", {
    filter: (node) =>
      node.nodeType === 1 && node.dataset && node.dataset.tex &&
      node.classList && (node.classList.contains("math-inline") || node.classList.contains("math-display")),
    replacement: (content, node) => {
      let tex = "";
      try {
        tex = decodeURIComponent(node.dataset.tex);
      } catch (err) {
        tex = "";
      }
      if (!tex.trim()) return content;
      return node.classList.contains("math-display")
        ? `\n\n$$\n${tex.trim()}\n$$\n\n`
        : `$${tex.trim()}$` + (followedByInlineMath(node) ? " " : "");
    }
  });

  // Fallback for math with no data-tex host: the renderMathInElement safety net
  // in enhanceRenderedMarkdown renders bare \[…\] / \(…\) delimiters straight
  // out of the DOM, and pasted web HTML arrives pre-rendered by somebody else's
  // KaTeX. Both leave only KaTeX's own <annotation> to recover the TeX from.
  turndownService.addRule("katex", {
    filter: function (node) {
      return node.nodeName === "SPAN" && node.classList.contains("katex");
    },
    replacement: function (content, node) {
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) {
        const tex = annotation.textContent.trim();
        // .katex-display is the PARENT of span.katex, neither the node itself
        // nor a descendant — so the old check was never true and display math
        // always came back as inline $…$. That mattered: findInlineDollarClose
        // caps inline math at INLINE_MATH_MAX_SPAN and stops at a blank line,
        // so a long \begin{aligned} block landed on the card as literal
        // unrendered "$\begin{aligned}…$" text. (recall-clipper's picker.js
        // splits this into katexDisplay/katexInline rules for the same reason.)
        const isDisplay = Boolean(node.closest?.(".katex-display"));
        return isDisplay ? "\n\n$$\n" + tex + "\n$$\n\n" : "$" + tex + "$" + (followedByInlineMath(node) ? " " : "");
      }
      // No annotation — KaTeX built with output:"html" emits none, and a clone
      // can lose it. `content` here is the serialized glyph soup, so try the
      // stashed source one more time before falling back to it.
      const host = node.closest?.("[data-tex]");
      if (host) {
        try {
          const tex = decodeURIComponent(host.dataset.tex).trim();
          if (tex) {
            return host.classList.contains("math-display")
              ? `\n\n$$\n${tex}\n$$\n\n`
              : `$${tex}$` + (followedByInlineMath(node) ? " " : "");
          }
        } catch (err) {
          /* fall through to content */
        }
      }
      return content;
    }
  });

  if (options.epubMode) {
    // EPUB citation/footnote markers point at real in-book footnotes or
    // endnotes (often on the same page, or their own spine chapter) — unlike
    // a web paste, the target isn't dead, so keep the marker instead of
    // stripping it. Rendered via textContent (not the link's markdown) so a
    // nested markdown link inside a raw <sup> HTML tag never has to survive
    // the app's Markdown renderer, which isn't guaranteed to re-parse
    // markdown syntax nested inside inline HTML.
    turndownService.addRule("epub-sup", {
      filter: "sup",
      replacement: (content, node) => `<sup>${node.textContent.trim()}</sup>`
    });
    turndownService.addRule("epub-sub", {
      filter: "sub",
      replacement: (content, node) => `<sub>${node.textContent.trim()}</sub>`
    });
  } else {
    // Citation/footnote markers (Wikipedia's "[1]", "[a]" etc.) are a <sup> that
    // wraps a single link to an in-page anchor (e.g. #cite_note-6, or — when
    // copied from a live page rather than raw HTML — the browser resolves that
    // to an absolute URL like ".../Albert_Einstein#cite_note-6"). The anchor
    // target never survives the paste, so keeping them just litters notes with
    // dead, bracket-clad links scattered through the text — drop the marker and
    // keep the surrounding prose clean.
    turndownService.addRule("footnote-reference", {
      filter: function (node) {
        if (node.nodeName !== "SUP") return false;
        const links = node.querySelectorAll("a");
        if (links.length !== 1) return false;
        const href = links[0].getAttribute("href") || "";
        const hashIndex = href.indexOf("#");
        if (hashIndex === -1) return false;
        if (href.startsWith("#")) return true;
        const fragment = href.slice(hashIndex + 1);
        return /^(cite_note|cite_ref|fn|footnote|note)[-_]/i.test(fragment);
      },
      replacement: function () {
        return "";
      }
    });
  }

  // Intercept and ignore MathJax rendering containers, extracting raw text from mjx-copytext
  turndownService.addRule("mathjax-containers", {
    filter: function (node) {
      return (
        (node.classList && (
          node.classList.contains("MathJax") ||
          node.classList.contains("MathJax_Preview") ||
          node.classList.contains("MathJax_Display")
        )) ||
        node.nodeName === "MJX-CONTAINER"
      );
    },
    replacement: function (content, node) {
      if (node.nodeName === "MJX-CONTAINER") {
        const copyTextEl = node.querySelector("mjx-copytext");
        if (copyTextEl) return copyTextEl.textContent.trim();
      }
      return "";
    }
  });

  // Extract LaTeX from MathJax 2 script tags
  turndownService.addRule("mathjax-script", {
    filter: function (node) {
      return node.nodeName === "SCRIPT" && node.type && node.type.startsWith("math/tex");
    },
    replacement: function (content, node) {
      const tex = node.textContent.trim();
      const isDisplay = node.type.includes("mode=display");
      return isDisplay ? "\n$$\n" + tex + "\n$$\n" : "$" + tex + "$";
    }
  });

  // Page chrome that is never content: scripts, styles, widgets, form fields,
  // icon SVGs and buttons. Turndown's own tables keep SCRIPT around
  // ("meaningful when blank"), so its text — "var x = 1;", ".a{color:red}",
  // "Copy code" — used to leak into pasted notes as if it were prose. The
  // selection-capture path already removes these from the fragment
  // (cleanedSelectionFragment), so this just makes paste agree with it.
  turndownService.addRule("page-chrome", {
    filter: (node) =>
      node.nodeType === 1 &&
      /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|EMBED|CANVAS|SVG|SELECT|BUTTON|INPUT|TEXTAREA)$/.test(node.nodeName),
    replacement: () => ""
  });

  // MathML with no usable glyph fallback: Wikipedia and pandoc put the TeX in
  // an <annotation> or in alttext, and Turndown would otherwise serialize the
  // presentation glyphs ("x=-b2a") — math destroyed on the way in. Recover the
  // source, the same way the katex rule above recovers it for KaTeX markup.
  turndownService.addRule("mathml-tex", {
    filter: (node) => node.nodeType === 1 && node.nodeName.toLowerCase() === "math",
    replacement: (content, node) => {
      const annotation =
        node.querySelector('annotation[encoding="application/x-tex"]') || node.querySelector("annotation");
      let tex = sanitizeMathTex(annotation?.textContent || node.getAttribute("alttext") || "");
      // No annotation at all (Nougat-OCR books leave dozens of formulas as
      // bare MathML): convert the presentation MathML itself — anything is
      // better than the glyph run, which is not even text.
      if (!tex) tex = mathmlToTex(node);
      if (!tex) return content;
      // Nougat marks even display equations display="inline" when they lack
      // an annotation; the div.math-display wrapper is the reliable signal.
      const isDisplay = node.getAttribute("display") === "block" ||
        Boolean(node.closest?.("div.math-display"));
      if (isDisplay) {
        // epubContainerToMarkdown folds a display equation's number (<span
        // class="math-tag">(16)</span>) onto the math as data-tag — emit it
        // as a real amsmath tag instead of an orphan "(16)" paragraph.
        const tag = (node.getAttribute("data-tag") || "").replace(/[{}]/g, "").trim();
        if (tag) tex = `${tex}\\tag{${tag}}`;
        return `\n\n$$\n${tex}\n$$\n\n`;
      }
      // Two inline formulas back to back in the source would concatenate
      // into "$=$$12$" — which protectMath reads as one display-math
      // delimiter pair, swallowing the prose around it. Keep them apart.
      return `$${tex}$` + (followedByInlineMath(node) ? " " : "");
    }
  });

  // AI chats (Claude/ChatGPT/Gemini/Copilot) wrap the <code> of a fenced block
  // in extra divs, or put their header bar INSIDE the <pre>. Turndown's
  // built-in fencedCodeBlock only fires when the <code> is the <pre>'s FIRST
  // child, so those blocks used to collapse into a single inline-code line
  // with the newlines flattened out. Same output shape as the built-in rule,
  // just found deeper.
  turndownService.addRule("fenced-code-nested", {
    filter: (node) =>
      node.nodeName === "PRE" &&
      !(node.firstElementChild && node.firstElementChild.nodeName === "CODE") &&
      Boolean(node.querySelector("code")),
    replacement: (content, node) => {
      const code = node.querySelector("code");
      const language = ((code.getAttribute("class") || "").match(/language-([\w+-]+)/) || [])[1] || "";
      const text = code.textContent.replace(/\n$/, "");
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    }
  });

  // Turndown 7.1.2's built-in listItem rule always indents a list item's
  // second+ line (a loose <li> with more than one <p>, e.g. an endnote's
  // citation followed by a "go to reference" link) by a hardcoded 4 spaces,
  // regardless of how wide the marker actually is. That only lines up for a
  // single-digit ordered marker ("1.  " is 4 chars); a two-digit one ("32.  "
  // is 5 chars) leaves the continuation one column short of the list's
  // content column. marked/CommonMark then stops treating it as part of the
  // list item — a bare 4-space-indented line at that point IS the syntax for
  // an indented code block, so the link renders as inert code instead of a
  // clickable link. Re-deriving the indent from the actual prefix width (the
  // same computation turndown itself does) fixes this for every marker size.
  turndownService.addRule("list-item-indent-fix", {
    filter: "li",
    replacement: function (content, node, options) {
      content = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n");
      let prefix = options.bulletListMarker + "   ";
      const parent = node.parentNode;
      if (parent.nodeName === "OL") {
        const start = parent.getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = (start ? Number(start) + index : index + 1) + ".  ";
      }
      content = content.replace(/\n/gm, "\n" + " ".repeat(prefix.length));
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
    }
  });

  return turndownService;
}

// Strips page chrome out of a parsed clipboard fragment before Turndown sees
// it. Copied web/AI-chat HTML carries a lot of markup that is not content:
// visually-hidden duplicate glyphs (aria-hidden), and code-block header bars
// ("python  ⧉ Copy") sitting next to the <pre>. Turndown's default handling
// keeps their TEXT as if it were prose, so a paste used to come out with
// "pythonCopy" lines baked in.
export function cleanClipboardDom(root) {
  // aria-hidden nodes duplicate what the visible nodes already say (KaTeX's
  // glyph half, screen-reader spans) or are pure decoration (icon fonts).
  root.querySelectorAll("[aria-hidden='true']").forEach((node) => node.remove());

  // A code block's header bar is the <pre>'s immediate sibling and holds the
  // language label plus a copy button. Once the button itself is dropped (the
  // page-chrome rule below) only the stray label word would be left — remove
  // the whole bar instead. The button is the evidence: a plain short div of
  // prose in front of a <pre> is content and stays.
  root.querySelectorAll("pre").forEach((pre) => {
    const sibling = pre.previousElementSibling;
    if (!sibling || /^(P|UL|OL|DL|H[1-6]|BLOCKQUOTE|TABLE)$/.test(sibling.nodeName)) return;
    if (sibling.querySelector("a, img, pre, code")) return;
    if (!sibling.querySelector("button, [role='button'], [class*='copy' i]")) return;
    if (sibling.textContent.trim().length > 30) return;
    sibling.remove();
  });

  return root;
}

export function turndownWithService(turndownService, html, options = {}) {
  try {
    // Parsed here rather than handed to Turndown as a string, because the math
    // spans have to be lifted out of the DOM before conversion — see
    // protectMathInDom.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const markdown = turndownService.turndown(protectMathInDom(cleanClipboardDom(doc.body)));
    // Belt and braces. protectMathInDom works from the DOM, so it depends on
    // recognising how a given site lays its formulas out, and sites keep
    // inventing new ways — math split across elements the flattener treats as
    // opaque, delimiters buried in a widget, and so on. This pass works on the
    // finished markdown instead, where the damage has an unmistakable
    // signature ("\\begin", "\\dots", "x\_v"), so it heals what got through no
    // matter what the source markup looked like. Same function that repairs
    // notes already in storage, so paste and repair can never disagree.
    return repairEscapedMathMarkdown(markdown);
  } catch (err) {
    console.error("Turndown conversion failed", err);
    return "";
  }
}
