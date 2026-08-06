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
    return String(value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function encodeAttribute(value) { return escapeHtml(encodeURIComponent(value)); }

  // ── Math protection (LaTeX → placeholder nodes rendered later by KaTeX) ───
  function isEscaped(source, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
    return slashes % 2 === 1;
  }
  function isSingleDollarLine(source, index) {
    if (source[index] !== "$" || source[index - 1] === "$" || source[index + 1] === "$" || isEscaped(source, index)) return false;
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    const lineEnd = source.indexOf("\n", index);
    const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
    return line.trim() === "$";
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
  function findInlineDollarClose(source, start) {
    for (let index = source.indexOf("$", start); index !== -1; index = source.indexOf("$", index + 1)) {
      const previous = source[index - 1];
      if (source[index + 1] !== "$" && previous && !/\s/.test(previous) && !isEscaped(source, index)) return index;
    }
    return -1;
  }
  function mathNode(tex, displayMode) {
    const tag = displayMode ? "div" : "span";
    const className = displayMode ? "math-display" : "math-inline";
    return `<${tag} class="${className}" data-tex="${encodeAttribute(tex.trim())}"></${tag}>`;
  }
  function normalizeDisplayMathIndentation(markdown) {
    return markdown
      .replace(/(^|\n)[ \t]{4,}\$\$[ \t]*\n([\s\S]*?)\n[ \t]{4,}\$\$[ \t]*(?=\n|$)/g, (match, prefix, tex) => {
        const normalizedTex = tex.split("\n").map((line) => line.replace(/^[ \t]{4}/, "")).join("\n");
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
      const precededByLinkBracket = index > 0 && source[index - 1] === "[" && !isEscaped(source, index - 1);
      if (!precededByLinkBracket && (source.startsWith("\\[", index) || source.startsWith("\\(", index)) && !isEscaped(source, index)) {
        const displayMode = source[index + 1] === "[";
        const closeToken = displayMode ? "\\]" : "\\)";
        const close = findUnescaped(source, closeToken, index + 2);
        if (close !== -1) {
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
      output += source[index];
      index += 1;
    }
    return output;
  }

  // ── Cloze + inline transforms (skip inline code spans) ────────────────────
  function applyClozeMarkup(text) {
    return String(text).replace(
      /\{\{([\s\S]+?)\}\}/g,
      (_m, inner) => `<span class="cloze" tabindex="0" role="button" aria-label="Hidden text, tap to reveal">${inner}</span>`
    );
  }
  function protectInline(segment) {
    let output = "";
    let i = 0;
    const len = segment.length;
    while (i < len) {
      const clozeStart = segment.indexOf("{{", i);
      const backtickMatch = /`+/.exec(segment.slice(i));
      const codeStart = backtickMatch ? i + backtickMatch.index : -1;
      if (codeStart !== -1 && (clozeStart === -1 || codeStart < clozeStart)) {
        const tickRun = backtickMatch[0];
        const afterOpen = codeStart + tickRun.length;
        const closeRe = new RegExp("`{" + tickRun.length + "}(?!`)");
        const closeMatch = closeRe.exec(segment.slice(afterOpen));
        if (closeMatch) {
          const codeEnd = afterOpen + closeMatch.index + closeMatch[0].length;
          output += protectMath(applyClozeMarkup(segment.slice(i, codeStart)));
          output += segment.slice(codeStart, codeEnd);
          i = codeEnd;
          continue;
        }
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
    const lineRe = new RegExp(`^[^\\S\\n]*(?:${IMG_TOKEN_SOURCE})(?:[^\\S\\n]*\\|[^\\S\\n]*(?:${IMG_TOKEN_SOURCE}))+[^\\S\\n]*$`, "gm");
    const imgRe = new RegExp(IMG_TOKEN_SOURCE, "gi");
    return segment.replace(lineRe, (line) => {
      const imgs = (line.match(imgRe) || []).map(imageMarkupToTag).filter(Boolean);
      if (imgs.length < 2) return line;
      return `<div class="notes-img-row">${imgs.join("")}</div>`;
    });
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
      output += protectInline(renderImageRows(source.slice(lastIndex, match.index)));
      if (/\bmermaid\b/i.test(match[1])) {
        output += `<div class="mermaid" data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
      } else if (/\bnomnoml\b/i.test(match[1])) {
        output += `<div class="nomnoml-diagram" data-diagram="${encodeAttribute(match[2].trim())}"></div>`;
      } else {
        output += match[0];
      }
      lastIndex = fencePattern.lastIndex;
    }
    output += protectInline(renderImageRows(source.slice(lastIndex)));
    return output;
  }

  // ── Google-Drive share links → embeddable image URLs ─────────────────────
  function normalizeImageUrl(url) {
    if (!url) return url;
    const m = String(url).match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^&]*&)*id=|thumbnail\?(?:[^&]*&)*id=)([\w-]{20,})/);
    if (!m) return url;
    return `https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`;
  }

  // ── Markdown → sanitized HTML (matches Recall's markdownToSafeHtml) ───────
  function markdownToSafeHtml(md) {
    const prepared = preprocessSpecialBlocks(md || "");
    const html = marked.parse(prepared);
    return DOMPurify.sanitize(html, {
      ADD_TAGS: ["foreignObject", "font", "u", "del", "kbd"],
      ADD_ATTR: ["target", "rel", "class", "data-tex", "data-diagram", "style", "color", "face", "tabindex", "role", "aria-label"]
    });
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
      if (typeof renderMathInElement === "function") {
        try {
          renderMathInElement(container, {
            delimiters: [
              { left: "\\[", right: "\\]", display: true },
              { left: "\\(", right: "\\)", display: false },
              { left: "$", right: "$", display: false }
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
