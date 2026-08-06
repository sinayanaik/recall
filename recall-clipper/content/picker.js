// Recall Clipper — injected element picker + Markdown converter.
//
// Runs in the page's isolated content-script world. Re-injecting this file
// toggles the tool off (the background worker just re-runs it), so the whole
// thing is wrapped in an IIFE that tears down a previous instance and returns.
//
// Globals injected just before this file by the background worker:
//   TurndownService     (vendor/turndown.js)
//   turndownPluginGfm   (vendor/turndown-plugin-gfm.js)
//   marked              (vendor/marked.min.js)          — for the rendered preview
//   DOMPurify           (vendor/purify.min.js)          — sanitises that preview
//   window.__recallMath (content/recall-math.js)        — math capture, ported from app.js
(function () {
  "use strict";

  const UI_ID = "recall-clipper-ui";
  const OVERLAY_ID = "recall-clip-overlay";
  const REMOVE_ATTR = "data-recall-clip-removed";
  const ACTIVE_CLASS = "recall-clip-active";

  // ---- Toggle-off: a second activation tears the existing instance down ----
  if (window.__recallClipper && typeof window.__recallClipper.destroy === "function") {
    window.__recallClipper.destroy();
    return;
  }
  if (typeof TurndownService !== "function") {
    console.error("Recall Clipper: Turndown failed to load.");
    return;
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let mode = "select";                 // "select" (keep) | "remove" (trim)
  const kept = new Map();              // Element -> overlay box
  // Remove now genuinely deletes elements from the live page. Each removed
  // element maps to its saved inline `display` so we can put it back exactly.
  const removed = new Map();           // Element -> { value, priority }
  const removeOrder = [];              // removal order, for Undo (Ctrl+Z)
  // Isolate collapses the page to just the kept blocks; same save/restore trick.
  const isolated = new Map();          // Element -> { value, priority }
  let isolateOn = false;
  let hoverEl = null;
  let rafId = 0;
  // How the last clip's math went: { captured, missed }, so the toast can say.
  let lastMath = { captured: 0, missed: 0 };

  // ---------------------------------------------------------------------------
  // Overlay layer — every selection mark is a floating box that we re-glue to
  // its element every animation frame. Because the boxes live in our own layer
  // (not as classes on the page's elements) they can't be clobbered by the
  // page's CSS, survive SPA re-renders, and never disturb the page's layout.
  // ---------------------------------------------------------------------------
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  document.documentElement.appendChild(overlay);

  const hoverBox = document.createElement("div");
  hoverBox.className = "rc-hover";
  hoverBox.style.display = "none";
  overlay.appendChild(hoverBox);

  function makeBox(kind) {
    const box = document.createElement("div");
    box.className = `rc-box rc-${kind}`;
    const badge = document.createElement("span");
    badge.className = "rc-badge";
    box.appendChild(badge);
    overlay.appendChild(box);
    return box;
  }

  function place(box, el) {
    const r = el.getBoundingClientRect();
    box.style.top = `${r.top}px`;
    box.style.left = `${r.left}px`;
    box.style.width = `${Math.max(r.width, 0)}px`;
    box.style.height = `${Math.max(r.height, 0)}px`;
  }

  function placeHover(el) {
    if (!el || el.closest(`#${UI_ID}`) || el === document.documentElement || el === document.body) {
      hoverBox.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) { hoverBox.style.display = "none"; return; }
    hoverBox.style.display = "block";
    hoverBox.dataset.mode = mode;
    place(hoverBox, el);
  }

  // rAF loop: keep every keep-box glued, prune anything whose element left the
  // DOM. Removed/isolated elements are hidden live (no overlay box), so we only
  // need to forget them once the page drops them.
  function tick() {
    if (hoverEl && hoverBox.style.display !== "none") placeHover(hoverEl);
    let changed = false;
    for (const [el, box] of kept) {
      if (!document.contains(el)) { box.remove(); kept.delete(el); changed = true; continue; }
      place(box, el);
    }
    for (const el of Array.from(removed.keys())) {
      if (!document.contains(el)) { removed.delete(el); dropFrom(removeOrder, el); }
    }
    for (const el of Array.from(isolated.keys())) {
      if (!document.contains(el)) isolated.delete(el);
    }
    if (changed) { renumberKept(); if (isolateOn) applyIsolation(); updateCount(); }
    rafId = requestAnimationFrame(tick);
  }

  function dropFrom(arr, item) { const i = arr.indexOf(item); if (i >= 0) arr.splice(i, 1); }

  function renumberKept() {
    const ordered = orderedKeptEls();
    ordered.forEach((el, i) => {
      const box = kept.get(el);
      if (box) box.querySelector(".rc-badge").textContent = `✓ ${i + 1}`;
    });
  }

  function orderedKeptEls() {
    return Array.from(kept.keys()).sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Live page manipulation
  //
  // Remove genuinely deletes an element from the page; Isolate collapses the
  // page down to the kept blocks. Both work by driving each element's inline
  // `display` (the strongest CSS wins, so page styles can't fight us) and are
  // fully reversible — we stash the prior value and put it back on undo / clear
  // / close. The live page is therefore only ever changed while the tool is on.
  // ---------------------------------------------------------------------------
  function savedDisplay(el) {
    return {
      value: el.style.getPropertyValue("display"),
      priority: el.style.getPropertyPriority("display"),
      // Whether the element had a style attribute AT ALL, which is not the same
      // question as what its display was — see restoreLive.
      hadStyleAttr: el.hasAttribute("style")
    };
  }
  function hideLive(el) { el.style.setProperty("display", "none", "important"); }
  function restoreLive(el, saved) {
    if (!saved) return;
    if (saved.value) el.style.setProperty("display", saved.value, saved.priority);
    else el.style.removeProperty("display");
    // Touching el.style materialises a style attribute on an element that never
    // had one, and removeProperty leaves it behind empty. Without this, every
    // block the picker hid keeps a style="" for the rest of the page's life —
    // visible in devtools, matched by [style] selectors, and a broken promise:
    // this file's whole contract is that the page is unchanged once we're off.
    if (!saved.hadStyleAttr && !el.style.length) el.removeAttribute("style");
  }
  function isOurs(el) { return el === ui || el === overlay || (ui.contains && ui.contains(el)) || (overlay.contains && overlay.contains(el)); }

  // ---------------------------------------------------------------------------
  // Selection bookkeeping
  // ---------------------------------------------------------------------------
  function markKept(el) {
    if (isOurs(el)) return;
    if (removed.has(el)) { restoreLive(el, removed.get(el)); removed.delete(el); dropFrom(removeOrder, el); }
    if (kept.has(el)) {
      kept.get(el).remove();
      kept.delete(el);
    } else {
      const box = makeBox("keep");
      place(box, el);
      kept.set(el, box);
    }
    renumberKept();
    if (isolateOn) applyIsolation();
    updateCount();
  }

  function markRemoved(el) {
    if (isOurs(el)) return;
    if (kept.has(el)) { kept.get(el).remove(); kept.delete(el); renumberKept(); }
    if (removed.has(el)) {                 // toggle back off (Undo also does this)
      restoreLive(el, removed.get(el));
      removed.delete(el);
      dropFrom(removeOrder, el);
    } else {
      removed.set(el, savedDisplay(el));   // delete it from the live page
      removeOrder.push(el);
      hideLive(el);
    }
    if (isolateOn) applyIsolation();
    updateCount();
  }

  // Undo the most recent Remove, putting that element back on the page.
  function undoRemove() {
    const el = removeOrder.pop();
    if (!el) return false;
    restoreLive(el, removed.get(el));
    removed.delete(el);
    if (isolateOn) applyIsolation();
    updateCount();
    return true;
  }

  // Hide everything on the page except the kept subtrees (and keep removed
  // blocks removed). Walks down from <body>, keeping only branches that lead to
  // — or are inside — a kept element.
  function applyIsolation() {
    clearIsolation();
    const keepEls = Array.from(kept.keys()).filter((el) => document.contains(el));
    if (!keepEls.length) return;
    const keptSet = new Set(keepEls);
    const onPath = new Set();
    keepEls.forEach((el) => { for (let n = el; n; n = n.parentElement) onPath.add(n); });
    (function walk(node) {
      for (const child of Array.from(node.children)) {
        if (isOurs(child) || keptSet.has(child)) continue;     // our UI, or a kept subtree — leave visible
        if (onPath.has(child)) { walk(child); continue; }      // ancestor of a kept element — descend
        if (removed.has(child) || isolated.has(child)) continue; // already hidden
        isolated.set(child, savedDisplay(child));              // no kept element inside — hide the branch
        hideLive(child);
      }
    })(document.body);
  }
  function clearIsolation() {
    isolated.forEach((saved, el) => restoreLive(el, saved));
    isolated.clear();
  }
  function setIsolate(on) {
    if (on && !kept.size) { toast("Select blocks to keep first — Isolate then hides everything else.", false); return; }
    isolateOn = on;
    if (isoBtn) { isoBtn.classList.toggle("is-active", on); isoBtn.setAttribute("aria-pressed", on ? "true" : "false"); }
    if (on) applyIsolation(); else clearIsolation();
  }

  function clearAll() {
    kept.forEach((box) => box.remove());
    kept.clear();
    Array.from(removed.keys()).forEach((el) => restoreLive(el, removed.get(el)));
    removed.clear();
    removeOrder.length = 0;
    clearIsolation();
    isolateOn = false;
    if (isoBtn) { isoBtn.classList.remove("is-active"); isoBtn.setAttribute("aria-pressed", "false"); }
    updateCount();
  }

  // ---------------------------------------------------------------------------
  // Event handling (capture phase, so the page never sees our picking clicks)
  // ---------------------------------------------------------------------------
  function onMouseMove(e) {
    const t = e.target;
    if (t && t.closest && t.closest(`#${UI_ID}`)) { hoverEl = null; hoverBox.style.display = "none"; return; }
    hoverEl = t;
    placeHover(t);
  }

  function onClick(e) {
    const t = e.target;
    if (t && t.closest && t.closest(`#${UI_ID}`)) return; // let our own UI work
    e.preventDefault();
    e.stopPropagation();
    if (!t || t === document.documentElement || t === document.body) return;
    if (mode === "select") markKept(t);
    else markRemoved(t);
    placeHover(t);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") { e.preventDefault(); destroy(); return; }
    // Ctrl/Cmd+Z restores the most recently removed (deleted) block.
    if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
      if (removeOrder.length) {
        e.preventDefault(); e.stopPropagation();
        undoRemove();
        toast("Restored last removed block. (Ctrl+Z again for more)");
      }
      return;
    }
    // Quick mode switch: S = select, R = remove (ignore while typing in a field).
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target?.isContentEditable) return;
    if (e.key === "s" || e.key === "S") setMode("select");
    else if (e.key === "r" || e.key === "R") setMode("remove");
  }

  // Stop navigations / focus changes on interactive elements while picking, but
  // leave plain content alone so native text selection still works as a fallback.
  function onPointerDown(e) {
    const t = e.target;
    if (t && t.closest && t.closest(`#${UI_ID}`)) return;
    if (t && t.closest && t.closest("a,button,summary,label,select,[role='button']")) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---------------------------------------------------------------------------
  // Markdown conversion
  // ---------------------------------------------------------------------------

  // Page chrome that isn't content: Medium's "expand image" affordance, its
  // zoom button, and similar noise other readers inject next to figures. These
  // are matched exactly (case-insensitively) so real captions survive.
  const NOISE_EXACT = [
    /^press enter or click to view image in full size$/i,
    /^click to view image in full size$/i,
    /^zoom$/i,
    /^open in app$/i,
  ];
  const NOISE_SUBSTR = /press enter or click to view image in full size/gi;

  // Heading permalink affordances and bare fragment markers. Static-site and
  // blog engines (Docusaurus, MkDocs, GitBook, Ghost, rehype-slug, GitHub…)
  // drop a little "#" / "¶" / "§" / "🔗" link next to every heading, and
  // reference/citation widgets add fragment links too. When their *only* visible
  // text is such a glyph they carry no content — they just leave a stray "#" on
  // the heading (see "Final Summary#") and, wrapped in a block, blank lines.
  const ANCHOR_CLASS = /(?:^|\s)(?:anchor|header-?link|hash-?link|heading-?link|perma-?link|anchor-?link|autolink-header|footnote-back-?ref|footnote-backref)(?:\s|$)/i;
  // Affordance-only glyphs, incl. footnote back-reference arrows (↩ ↵ ⮐) that
  // sit at the end of every reference in a footnotes list.
  const AFFORDANCE_TEXT = /^[#¶§⚓🔗↩↵⮐\s]*$/;

  // Citation / footnote reference markers. These vary a lot across sites but
  // share a shape: a short numeric (or bracketed-numeric) marker, usually a
  // same-page fragment link, often inside <sup>, sometimes flagged by class.
  // Turndown turns them into escaped links — `[\[1\]](#fn1)` — which peppers the
  // prose with backslashes and dead anchors. We detect them and emit a clean,
  // unescaped inline `[n]` instead. CITE_TEXT stays deliberately narrow (digits,
  // ranges, comma/semicolon lists, a trailing letter like 12a) so ordinary
  // superscripts (x², 1st) and real links never get swept in.
  const CITE_CLASS = /(?:^|\s|_)(?:reference|references|citation|cite|footnote|footnote-ref|fnref|fn|noteref|endnote)(?:[\s_-]|$)/i;
  const CITE_HREF = /^#(?:fn|fnref|cite|ref|reference|footnote|note|endnote|_?ftn)/i;
  const CITE_TEXT = /^\[?\s*\d+[a-z]?(?:\s*[-–—,;]\s*\d+[a-z]?)*\s*\]?$/i;

  function citationText(node) {
    return (node.textContent || "").replace(/\s+/g, " ").trim();
  }
  // Is this <a> a citation/footnote reference (not a normal link)?
  function isCitationLink(node) {
    if (!node || node.nodeName !== "A") return false;
    const href = node.getAttribute("href") || "";
    if (!href.startsWith("#")) return false;            // only same-page anchors
    const txt = citationText(node);
    if (!CITE_TEXT.test(txt)) return false;             // must look like [n]/n
    const parent = node.parentNode;
    const inSup = parent && parent.nodeName === "SUP";
    const cls = (node.getAttribute("class") || "") + " " +
      ((parent && parent.getAttribute && parent.getAttribute("class")) || "");
    return inSup || CITE_CLASS.test(cls) || CITE_HREF.test(href) ||
      (parent && parent.id && CITE_HREF.test("#" + parent.id));
  }
  // Normalise a marker's visible text to a clean, unescaped `[n]`.
  function normalizeCite(txt) {
    const inner = txt.replace(/^\[|\]$/g, "").trim();
    return inner ? `[${inner}]` : "";
  }

  // Drop affordance-only links from a cloned subtree without touching real
  // links: a link is pulled only when its visible text is purely glyph/empty AND
  // it either points at a same-page fragment or carries a tell-tale anchor class.
  function stripAnchors(root) {
    root.querySelectorAll("a").forEach((a) => {
      if (a.querySelector("img, picture, code")) return; // real content inside
      const href = a.getAttribute("href") || "";
      const cls = a.getAttribute("class") || "";
      const txt = (a.textContent || "").replace(/ /g, " ").trim();
      if (!AFFORDANCE_TEXT.test(txt)) return;            // has real words — keep
      if (ANCHOR_CLASS.test(cls) || a.getAttribute("aria-hidden") === "true" || href.startsWith("#")) {
        a.remove();
      }
    });
  }

  // Content that is present in the DOM but hidden from readers: screen-reader-only
  // text, and the popover/tooltip cards that citation & footnote widgets tuck
  // inside a reference marker (the full reference, rendered as blocks). Copied
  // verbatim these dump the hidden text — and its blank lines — into the output.
  // Matched structurally (attributes/roles/classes) so nothing visible is lost.
  const HIDDEN_SEL = [
    '[hidden]',
    '[aria-hidden="true"]',
    '[role="tooltip"]',
    '.sr-only', '.visually-hidden', '.visuallyhidden', '.screen-reader-text', '.a11y-hidden',
  ].join(",");
  function stripHidden(root) {
    root.querySelectorAll(HIDDEN_SEL).forEach((el) => {
      // Keep it if it actually carries visible media — some sites mark real
      // figures aria-hidden for decoration but we shouldn't drop their content.
      if (el.querySelector("img, picture, pre, table, video")) return;
      el.remove();
    });
    // Inline display:none / visibility:hidden wrappers (common for hover-cards).
    root.querySelectorAll('[style]').forEach((el) => {
      const s = (el.getAttribute("style") || "").replace(/\s+/g, "").toLowerCase();
      if ((s.includes("display:none") || s.includes("visibility:hidden")) &&
          !el.querySelector("img, picture, pre, table, video")) el.remove();
    });
  }

  // Page furniture that is never the article: only ever stripped on the
  // "remaining" path, where the whole <body> is being clipped because the user
  // deleted the parts they didn't want. On the picked/selection paths the user's
  // choice is authoritative and nothing structural is second-guessed.
  const PAGE_CHROME = [
    "nav", "header", "footer", "aside",
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="complementary"]', '[role="search"]',
    ".sidebar", ".site-header", ".site-footer", ".site-nav", ".navbar", ".menu",
    ".comments", ".comment-list", ".related", ".related-posts", ".breadcrumb", ".breadcrumbs",
    ".cookie-banner", ".newsletter", ".share", ".social-share", ".advertisement", ".ad"
  ].join(",");

  function stripPageChrome(root) {
    root.querySelectorAll(PAGE_CHROME).forEach((el) => {
      // A <header> is also what an <article> puts its title in, and plenty of
      // sites wrap the whole post in a <section> with a .menu somewhere inside.
      // Only drop a branch that carries no substantial prose of its own.
      if ((el.textContent || "").trim().length > 600) return;
      if (el.querySelector("pre, table, figure")) return;
      el.remove();
    });
  }

  // Remove image-expand affordance text/buttons from a (cloned) subtree without
  // touching legitimate captions or the images themselves.
  //
  // extractPageMath runs FIRST and is not optional: KaTeX, MathJax and
  // Wikipedia all keep the formula's real LaTeX in a `display:none` subtree
  // (Wikipedia's is `<span class="mwe-math-mathml-inline" style="display:none">`),
  // which stripHidden — two lines below — would otherwise delete, leaving only
  // the fallback image for smartImages to turn into `![{\displaystyle …}](…svg)`.
  function scrubNoise(root) {
    if (window.__recallMath) lastMath = window.__recallMath.extractPageMath(root);
    stripAnchors(root);
    stripHidden(root);
    absolutizeUrls(root);
    root.querySelectorAll("*").forEach((el) => {
      // Never drop a wrapper that carries real content.
      if (el.querySelector("img, picture, pre, table, video")) return;
      const t = (el.textContent || "").replace(/ /g, " ").trim();
      if (t && NOISE_EXACT.some((re) => re.test(t))) el.remove();
    });
    // Mop up any stray phrase left inside a mixed text node.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const hits = [];
    let n;
    while ((n = walker.nextNode())) {
      if (NOISE_SUBSTR.test(n.nodeValue)) hits.push(n);
      NOISE_SUBSTR.lastIndex = 0;
    }
    hits.forEach((tn) => { tn.nodeValue = tn.nodeValue.replace(NOISE_SUBSTR, "").trim(); });
    return root;
  }

  // Reconstruct a code block's text, honouring <br> and per-line block elements
  // (many sites render each line as its own <div>/<span> with no real newline)
  // while leaving already-newlined <pre> text intact.
  function codeText(pre) {
    const codeEl = pre.querySelector("code") || pre;
    let out = "";
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          out += child.nodeValue;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.nodeName;
          if (tag === "BR") {
            out += "\n";
          } else if (/^(DIV|P|LI|TR|SECTION|OL|UL)$/.test(tag)) {
            const before = out.length;
            walk(child);
            if (out.length > before && !out.endsWith("\n")) out += "\n";
          } else {
            walk(child);
          }
        }
      }
    })(codeEl);
    return out.replace(/[ \t]+$/gm, "").replace(/^\n+/, "").replace(/\n+$/, "");
  }

  // Language hint from common class/attribute conventions (language-js,
  // lang-python, highlight-source-ts, brush: js, data-lang, etc.).
  function codeLang(pre) {
    const els = [pre.querySelector("code"), pre].filter(Boolean);
    for (const el of els) {
      const cls = el.getAttribute("class") || "";
      const m = cls.match(/(?:language|lang|highlight-source|brush)[-:\s]+([a-z0-9+#]+)/i);
      if (m) return m[1].toLowerCase();
    }
    for (const el of els) {
      const dl = el.getAttribute("data-lang") || el.getAttribute("data-language");
      if (dl) return String(dl).toLowerCase();
    }
    return "";
  }

  // Content-based language guess for code blocks that declare no language (very
  // common on Medium, blogs, docs). Scores a handful of signals per language and
  // returns the clear winner, or "" when nothing is confident enough — a wrong
  // guess is worse than none, so the bar to win is deliberately > a lone hit.
  function guessCodeLang(code) {
    const src = String(code || "");
    if (src.trim().length < 3) return "";
    const has = (re) => (re.test(src) ? 1 : 0);
    const count = (re) => (src.match(re) || []).length;

    // Structured formats first — they're unambiguous when they parse/match.
    const trimmed = src.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && /["}\]]\s*$/.test(trimmed) && /:\s/.test(trimmed)) {
      try { JSON.parse(trimmed); return "json"; } catch (_) { /* not valid JSON */ }
    }
    if (/^\s*<(?:!doctype|html|head|body|div|span|p|a|ul|li|table|svg|section|script|template)\b/i.test(src) || /<\/[a-z][\w-]*>/.test(src)) {
      return "markup";
    }

    const scores = {
      python: has(/\bdef\s+\w+\s*\(/) * 2 + has(/\b(?:import|from)\s+\w/) + has(/\bprint\s*\(/) + has(/\bself\b/) + has(/:\s*$/m) + has(/#[^!]/) + has(/\b(?:torch|numpy|np|pd|tensorflow|sklearn)\b/) - has(/;\s*$/m),
      bash: has(/^#!.*\b(?:bash|sh|zsh)\b/m) * 3 + has(/^\s*\$\s+/m) + has(/\b(?:sudo|apt|apt-get|yum|brew|npm|pip|git|cd|ls|echo|export|chmod|curl|wget|mkdir)\b\s+[-\w./]/) + count(/\$\{?\w+/g) * 0.3,
      typescript: has(/:\s*(?:string|number|boolean|any|void|unknown)\b/) * 2 + has(/\b(?:interface|type|enum|namespace)\s+\w/) + has(/\b(?:const|let)\b/) + has(/=>/),
      javascript: has(/\b(?:const|let|var)\s+\w+\s*=/) + has(/\bfunction\b/) + has(/=>/) + has(/\bconsole\.\w+\(/) * 2 + has(/\b(?:require|module\.exports|document|window)\b/) + has(/;\s*$/m),
      sql: (has(/\bselect\b[\s\S]*\bfrom\b/i) * 3 + has(/\b(?:insert\s+into|update|delete\s+from|create\s+table|join|where|group\s+by)\b/i)),
      css: has(/[.#]?[\w-]+\s*\{[^}]*:[^}]*;[^}]*\}/) * 2 + has(/@(?:media|import|keyframes)\b/) + has(/\b(?:margin|padding|color|background|display|font-size|border):/),
      java: has(/\b(?:public|private|protected)\s+(?:static\s+)?(?:class|void|int|String)\b/) * 2 + has(/System\.out\.print/) + has(/\bimport\s+java\./),
      cpp: has(/#include\s*<[\w.]+>/) * 2 + has(/\bstd::/) + has(/\b(?:cout|cin|endl)\b/) + has(/\bint\s+main\s*\(/),
      c: has(/#include\s*<[\w.]+\.h>/) * 2 + has(/\bprintf\s*\(/) + has(/\bint\s+main\s*\(/) - has(/\bstd::/),
      go: has(/\bpackage\s+\w+/) + has(/\bfunc\s+\w*\s*\(/) * 2 + has(/\bfmt\.\w+\(/) + has(/:=/),
      rust: has(/\bfn\s+\w+\s*\(/) * 2 + has(/\blet\s+mut\b/) + has(/\bprintln!/) + has(/\b(?:impl|trait|pub\s+fn)\b/),
      ruby: has(/\bdef\s+\w[\s\S]*?\bend\b/) * 2 + has(/\bputs\b/) + has(/\brequire\s+['"]/) + has(/\.each\s+do\b/),
      yaml: has(/^\s*[\w-]+:\s+\S/m) * 2 + has(/^\s*-\s+\w/m) - has(/[{};]/),
    };

    let best = "", bestScore = 0;
    for (const [lang, score] of Object.entries(scores)) {
      if (score > bestScore) { bestScore = score; best = lang; }
    }
    // Require a decisive signal (≥2) so ambiguous snippets stay unlabelled.
    return bestScore >= 2 ? best : "";
  }

  // ---------------------------------------------------------------------------
  // URLs
  //
  // Clipped Markdown leaves the page it came from, so a relative URL
  // (/wiki/Hinduism, //upload.wikimedia.org/…) is dead the moment it's pasted
  // into a deck. Resolve them against the source document while we still know
  // what it was.
  // ---------------------------------------------------------------------------
  // A `src` that is really a placeholder, not the picture. Lazy-loading widgets
  // park a tiny inline image in `src` and keep the real URL in a data-attribute
  // or srcset; the old test only knew the GIF and SVG spellings, so Medium and
  // Substack's 1×1 transparent PNG sailed through and the article's images all
  // came out blank. Any data: URI short enough to be a spacer is one.
  function isPlaceholderSrc(url) {
    if (!url) return true;
    if (!/^data:/i.test(url)) return false;
    return url.length < 2048;
  }

  // The widest candidate in a srcset ("a.jpg 400w, b.jpg 1200w" → b.jpg).
  function widestFromSrcset(srcset) {
    const candidates = String(srcset || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [url, descriptor = ""] = part.split(/\s+/);
        const width = /^(\d+)w$/.exec(descriptor);
        const density = /^([\d.]+)x$/.exec(descriptor);
        return { url, weight: width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 1 };
      })
      .filter((c) => c.url);
    if (!candidates.length) return "";
    return candidates.reduce((best, c) => (c.weight > best.weight ? c : best)).url;
  }

  const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-actualsrc", "data-hi-res-src", "data-full-src"];

  function bestImageUrl(img) {
    const src = img.getAttribute("src") || "";
    if (!isPlaceholderSrc(src)) return src;

    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (value && !isPlaceholderSrc(value)) return value;
    }
    const fromSrcset = widestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset"));
    if (fromSrcset && !isPlaceholderSrc(fromSrcset)) return fromSrcset;

    // <picture><source srcset="…"><img src="placeholder"> — the <img> carries
    // nothing usable and the real candidates live on its sibling <source>s.
    const picture = img.closest && img.closest("picture");
    if (picture) {
      for (const source of Array.from(picture.querySelectorAll("source"))) {
        const candidate = widestFromSrcset(source.getAttribute("srcset") || source.getAttribute("data-srcset"));
        if (candidate && !isPlaceholderSrc(candidate)) return candidate;
      }
    }
    return src;
  }
  function absoluteUrl(url) {
    if (!url || /^(?:data|blob):/i.test(url)) return url;
    try { return new URL(url, document.baseURI).href; } catch (_) { return url; }
  }
  // Fold each image down to its single best source and make every link absolute,
  // so later stages (and the table serializer) can just read the attribute back.
  function absolutizeUrls(root) {
    root.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (href && !href.startsWith("#")) a.setAttribute("href", absoluteUrl(href));
    });
    root.querySelectorAll("img").forEach((img) => {
      const url = bestImageUrl(img);
      if (url) img.setAttribute("src", absoluteUrl(url));
    });
  }

  // ---------------------------------------------------------------------------
  // Tables
  //
  // A GFM table is a rigid grid: the header row fixes the column count and the
  // renderer silently drops every cell past it. Real-world tables — a Wikipedia
  // infobox above all — are built from colspan/rowspan and nested tables, which
  // that grid cannot express at all. An infobox opens with a <th colspan="2">
  // title, which the GFM plugin reads as a *one-column* header, and so every
  // value in the second column is thrown away on the way out: you get "Venerated
  // in" and "Affiliation" with nothing beside them.
  //
  // So we split the two cases by capability. Tables that genuinely fit the grid
  // stay clean Markdown; the ones that don't are emitted as sanitised inline
  // HTML, which marked passes through untouched and Recall's DOMPurify allow-list
  // already covers — spans, nesting and all.
  //
  // This used to be a three-way user choice (Auto / HTML / Markdown). It isn't
  // one any more, because the two forced modes were both lossy in ways the user
  // had no way to see: "Markdown" flattened every table through a grid that
  // dropped <caption> outright and folded a nested table into a single cell,
  // and "HTML" turned even a plain two-column table into a wall of raw markup.
  // The capability test below decides per table, which is what "Auto" was
  // always trying to do — it just needed to be right more often (see
  // promoteHeaderRow) rather than to have an escape hatch bolted beside it.
  // ---------------------------------------------------------------------------
  function spanOf(cell, name) {
    const n = parseInt(cell.getAttribute(name) || "1", 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  // Mirrors turndown-plugin-gfm's own isHeadingRow. Without a heading row the
  // plugin declines the table entirely and `keep`s it as raw page HTML, so those
  // belong on our (sanitising) HTML path too.
  function tableHasHeadingRow(table) {
    const tr = table.rows && table.rows[0];
    if (!tr || !tr.parentNode) return false;
    const parent = tr.parentNode;
    if (parent.nodeName === "THEAD") return true;
    const prev = parent.previousSibling;
    const isFirstTbody = parent.nodeName === "TBODY" &&
      (!prev || (prev.nodeName === "THEAD" && /^\s*$/.test(prev.textContent)));
    if (parent.firstChild !== tr || !(parent.nodeName === "TABLE" || isFirstTbody)) return false;
    return Array.prototype.every.call(tr.childNodes, (n) => n.nodeName === "TH");
  }

  // Most tables on the open web have no <thead> at all — they open with a plain
  // <tr> of <td>s that is visually the header and semantically nothing. The GFM
  // plugin refuses those outright, so every ordinary blog table used to leave
  // here as raw HTML. If the shape is otherwise a clean grid, promote that first
  // row to <th> (on the detached clone — the live page is never touched) and it
  // becomes a proper Markdown table.
  //
  // Only when the first row genuinely reads as a header: short, non-empty,
  // distinct cells. A data row promoted by mistake is silently deleted content,
  // because a GFM header is not a row you can see.
  function canPromoteHeaderRow(table) {
    const tr = table.rows && table.rows[0];
    if (!tr || !tr.cells.length || table.rows.length < 2) return false;
    const cells = Array.from(tr.cells);
    if (cells.some((cell) => cell.querySelector("p, div, ul, ol, table, pre, img"))) return false;
    const texts = cells.map((cell) => (cell.textContent || "").trim());
    if (texts.some((t) => !t || t.length > 60)) return false;
    return new Set(texts).size === texts.length;
  }

  function promoteHeaderRow(table) {
    const tr = table.rows && table.rows[0];
    if (!tr) return;
    const doc = table.ownerDocument;
    Array.from(tr.cells).forEach((cell) => {
      if (cell.nodeName === "TH") return;
      const th = doc.createElement("th");
      Array.from(cell.attributes).forEach((a) => th.setAttribute(a.name, a.value));
      while (cell.firstChild) th.appendChild(cell.firstChild);
      cell.replaceWith(th);
    });
    // isHeadingRow also demands the row be the first child of the TABLE or of
    // the first TBODY; a promoted row inside a later section would still fail.
    const parent = tr.parentNode;
    if (parent && parent.nodeName === "TBODY" && parent.previousElementSibling) {
      const thead = doc.createElement("thead");
      thead.appendChild(tr);
      table.insertBefore(thead, table.firstChild);
    }
  }

  // Can this table survive the round-trip through a Markdown grid?
  function isGridTable(table) {
    if (table.querySelector("table")) return false;                       // nested
    for (const cell of table.querySelectorAll("th,td")) {
      if (spanOf(cell, "colspan") > 1 || spanOf(cell, "rowspan") > 1) return false;
    }
    return tableHasHeadingRow(table) || canPromoteHeaderRow(table);
  }

  // Give every Markdown-bound table the heading row the GFM plugin insists on.
  // Runs on the detached clone, just before conversion.
  function prepareGridTables(root) {
    Array.from(root.querySelectorAll("table")).forEach((table) => {
      if (isGridTable(table) && !tableHasHeadingRow(table)) promoteHeaderRow(table);
    });
  }

  // Which way each table in the clip is about to go, so the UI can say so out
  // loud instead of leaving the user to guess from the output. Counts outermost
  // tables only — a nested one travels inside its parent, not on its own.
  function tableStats(root) {
    const stats = { html: 0, md: 0 };
    Array.from(root.querySelectorAll("table"))
      .filter((t) => !(t.parentElement && t.parentElement.closest("table")))
      .forEach((t) => { stats[isGridTable(t) ? "md" : "html"]++; });
    return stats;
  }

  const TABLE_DROP = "script,style,noscript,iframe,canvas,svg,form,button,input,select,textarea,link,meta,object,embed";
  // Worth carrying into a deck: structure. Everything else (class, id, data-*,
  // the page's own JS hooks) is meaningless once the table is separated from
  // its site.
  const TABLE_ATTR = /^(?:colspan|rowspan|scope|align|valign|style|alt|title|href|src)$/i;
  // …and `style` only for the properties that describe the table's shape. The
  // rest is the site's paint job: a table clipped from a dark-themed page
  // carried `color:#fff; background:#111` into a deck and rendered as white text
  // on Recall's white page — invisible, with no way to tell it apart from a
  // failed clip. Recall themes its own tables in both light and dark, so the
  // source's colours are not just unhelpful, they're actively wrong.
  const TABLE_STYLE_KEEP = /^(?:text-align|vertical-align|width)$/i;

  function filterTableStyle(value) {
    return String(value || "")
      .split(";")
      .map((decl) => decl.trim())
      .filter(Boolean)
      .filter((decl) => TABLE_STYLE_KEEP.test(decl.split(":")[0].trim()))
      .join("; ");
  }

  function serializeTable(table) {
    const clone = table.cloneNode(true);
    clone.querySelectorAll(TABLE_DROP).forEach((n) => n.remove());
    // This path emits raw HTML, so Turndown's rules never see inside it — the
    // citation and anchor cleanup that runs everywhere else has to be applied
    // here by hand, or a clipped infobox keeps every dead "#cite_note-6" link
    // and its bracket spans while the prose around it comes out clean.
    stripAnchors(clone);
    clone.querySelectorAll("sup").forEach((sup) => {
      const link = sup.querySelector("a[href*='#']");
      const text = citationText(link && isCitationLink(link) ? link : sup);
      if (!CITE_TEXT.test(text)) return;
      sup.replaceWith(sup.ownerDocument.createTextNode(normalizeCite(text)));
    });
    clone.querySelectorAll("a[href]").forEach((a) => {
      if (isCitationLink(a)) a.replaceWith(a.ownerDocument.createTextNode(normalizeCite(citationText(a))));
    });
    // The <table> itself included — querySelectorAll("*") only sees descendants,
    // which would leave the page's own class/id hooks on the root element.
    [clone, ...clone.querySelectorAll("*")].forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        if (!TABLE_ATTR.test(a.name)) el.removeAttribute(a.name);
      });
      if (el.hasAttribute("style")) {
        const kept = filterTableStyle(el.getAttribute("style"));
        if (kept) el.setAttribute("style", kept);
        else el.removeAttribute("style");
      }
    });
    // Emit as a single line: marked ends an HTML block at the first blank line,
    // and one inside the table would spill the remainder back out as escaped
    // text — the table would tear in half.
    const html = clone.outerHTML.replace(/\s*\n\s*/g, " ").replace(/\s{2,}/g, " ").trim();
    return html ? `\n\n${html}\n\n` : "";
  }

  // A fence long enough to safely wrap the given code (never shorter than 3).
  function pickFence(code) {
    let n = 3;
    const re = /`{3,}/g;
    let m;
    while ((m = re.exec(code))) n = Math.max(n, m[0].length + 1);
    return "`".repeat(n);
  }

  const RAW_MATH_ATTR = (window.__recallMath && window.__recallMath.RAW_MATH_ATTR) || "data-recall-raw-math";

  function buildTurndown() {
    const td = new TurndownService({
      headingStyle: "atx", hr: "---", bulletListMarker: "-",
      codeBlockStyle: "fenced", fence: "```", emDelimiter: "*",
      strongDelimiter: "**", linkStyle: "inlined"
    });
    if (typeof turndownPluginGfm !== "undefined" && turndownPluginGfm.gfm) {
      td.use(turndownPluginGfm.gfm); // tables, strikethrough, task lists
    }

    // Turndown escapes every literal "[" and "]" so a bracket can never be
    // re-read as link syntax. That is one bracket too many here: "\[…\]" is also
    // KaTeX's display-math delimiter, so clipped prose like "[citation needed]"
    // came out escaped and then RENDERED AS MATH in the deck. Only a pair
    // immediately followed by "(" actually needs the escape. Same override
    // Recall's own paste handler installs.
    if (window.__recallMath) {
      const escapeMarkdown = td.escape.bind(td);
      td.escape = (string) => window.__recallMath.relaxEscapedBrackets(escapeMarkdown(string));
    }
    // The GFM plugin emits single-tilde strikethrough (~x~); Recall's Markdown
    // renderer (marked) only recognises the double-tilde form, so override it.
    td.addRule("strikethrough", {
      filter: ["del", "s", "strike"],
      replacement: (content) => `~~${content}~~`
    });

    // Markdown has no superscript or subscript, and Turndown's default is to
    // drop the tag and keep the text — so "x<sup>2</sup>" arrived as "x2" and
    // "H<sub>2</sub>O" as "H2O", which is not a formatting loss but a factual
    // one. Recall's sanitiser allows both tags, so emit them as raw HTML.
    // Registered BEFORE citationSup: Turndown consults added rules
    // most-recently-added first, so the narrower citation rule still wins on the
    // <sup>s that are really footnote markers.
    // Emitted from textContent, not from the converted content: Recall's
    // renderer isn't guaranteed to re-parse Markdown nested inside an inline
    // HTML tag, so a link or bold run inside a <sup> would arrive as its own
    // source text. Same trade app.js makes.
    td.addRule("keepSup", {
      filter: "sup",
      replacement: (_c, node) => {
        const text = (node.textContent || "").trim();
        return text ? `<sup>${escapeInlineHtml(text)}</sup>` : "";
      }
    });
    td.addRule("keepSub", {
      filter: "sub",
      replacement: (_c, node) => {
        const text = (node.textContent || "").trim();
        return text ? `<sub>${escapeInlineHtml(text)}</sub>` : "";
      }
    });

    // Citation / footnote markers → clean, unescaped inline `[n]`, no dead
    // anchor link. Handles the linked form (<sup><a href="#fn1">[1]</a></sup>,
    // Wikipedia-style <sup class="reference">…) directly; the plain-text form
    // (<sup>[1]</sup>, or bare `[1]` in prose) is de-escaped in tidyMarkdown.
    td.addRule("citationLink", {
      filter: (node) => isCitationLink(node),
      replacement: (_c, node) => normalizeCite(citationText(node))
    });
    // A <sup> that is purely a citation marker — keep it inline and unescaped so
    // it hugs the preceding word. A bare numeric <sup> with no link, bracket, or
    // citation class is treated as a math exponent (x²) and left to the default,
    // so we only claim it on a real citation signal.
    td.addRule("citationSup", {
      filter: (node) => {
        if (node.nodeName !== "SUP") return false;
        const link = node.querySelector && node.querySelector("a[href^='#']");
        if (link && isCitationLink(link)) return true;      // linked footnote
        const txt = citationText(node);
        if (!CITE_TEXT.test(txt)) return false;
        const cls = node.getAttribute("class") || "";
        return /^\[.*\]$/.test(txt) || CITE_CLASS.test(cls); // bracketed or flagged
      },
      replacement: (_c, node) => {
        const link = node.querySelector && node.querySelector("a[href^='#']");
        const txt = citationText(link && isCitationLink(link) ? link : node);
        return CITE_TEXT.test(txt) ? normalizeCite(txt) : _c;
      }
    });

    // Tables the Markdown grid can't hold → sanitised inline HTML. Registered
    // after the GFM plugin so it wins over both its table rule and its raw-HTML
    // `keep` fallback (Turndown checks added rules before kept ones,
    // most-recently-added first).
    td.addRule("complexTable", {
      filter: (node) => node.nodeName === "TABLE" && !isGridTable(node),
      replacement: (_c, node) => serializeTable(node)
    });

    td.remove(["script", "style", "noscript", "canvas", "svg", "form", "button", "input", "select", "textarea"]);

    // <math> can't go in the list above: Turndown's remove() compares an
    // uppercased tag name against node.nodeName, and a MathML element's
    // nodeName keeps its lowercase qualified name — so "MATH" never matches and
    // the element would fall through to the default handler, which prints its
    // leaf text ("x2"). extractPageMath has normally claimed every one already;
    // this catches whatever it declined.
    td.addRule("dropMathML", {
      filter: (node) => node.localName === "math",
      replacement: () => ""
    });

    // Fence every <pre> as a code block — including Medium's, which wrap code in
    // bare spans (no <code> child), so Turndown's built-in rule misses them and
    // the code leaks out as escaped prose (\[, \#, \_ …). Handling all <pre>
    // ourselves keeps code verbatim and unescaped.
    td.addRule("preBlock", {
      filter: (node) => node.nodeName === "PRE",
      replacement: (_content, node) => {
        const code = codeText(node);
        if (!code.trim()) return "";
        const fence = pickFence(code);
        const lang = codeLang(node) || guessCodeLang(code);
        return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
      }
    });

    // extractPageMath normally claims KaTeX before Turndown ever sees it; these
    // remain for anything it missed. They fall back to `content` rather than to
    // "" — KaTeX built with `output:"html"` emits no MathML annotation at all,
    // and returning "" there silently DELETED the equation instead of leaving
    // the rendered glyphs behind.
    td.addRule("katexDisplay", {
      filter: (node) => node.nodeType === 1 && node.classList && node.classList.contains("katex-display"),
      replacement: (content, node) => {
        const tex = node.querySelector('annotation[encoding="application/x-tex"]');
        return tex ? `\n\n$$\n${tex.textContent.trim()}\n$$\n\n` : content;
      }
    });
    td.addRule("katexInline", {
      filter: (node) => node.nodeType === 1 && node.classList && node.classList.contains("katex")
        && !(node.parentNode && node.parentNode.classList && node.parentNode.classList.contains("katex-display")),
      replacement: (content, node) => {
        const tex = node.querySelector('annotation[encoding="application/x-tex"]');
        return tex ? `$${tex.textContent.trim()}$` : content;
      }
    });
    td.addRule("smartImages", {
      filter: "img",
      replacement: (_c, node) => {
        // absolutizeUrls has normally already folded src down to the best
        // source; re-derive it anyway so the rule stands on its own.
        const url = absoluteUrl(bestImageUrl(node));
        if (!url) return "";
        const alt = (node.getAttribute("alt") || "").replace(/\n/g, " ").trim();
        return `![${alt}](${url})`;
      }
    });

    // A <figure> is an image and the caption that belongs to it. Turndown emits
    // the caption as an unremarkable paragraph, so a page with a dozen figures
    // becomes a dozen images each trailed by an orphan sentence. Italicise it,
    // which is how a caption reads as a caption in a deck.
    td.addRule("figcaption", {
      filter: "figcaption",
      replacement: (content) => {
        const text = content.replace(/\s+/g, " ").trim();
        return text ? `\n\n*${text}*\n\n` : "";
      }
    });

    // Inline formatting Recall's sanitiser allows and Turndown otherwise throws
    // away. <mark> in particular is Recall's own highlight syntax, so a page's
    // highlights survive as highlights instead of as unremarkable prose.
    td.addRule("keepMark", {
      filter: "mark",
      replacement: (content, node) => {
        if (!content.trim()) return content;
        const color = markColorName(node);
        return color ? `<mark data-color="${color}">${content}</mark>` : `<mark>${content}</mark>`;
      }
    });
    [["u", "U"], ["kbd", "KBD"], ["ins", "INS"]].forEach(([tag, nodeName]) => {
      td.addRule(`keep-${tag}`, {
        filter: (node) => node.nodeName === nodeName,
        replacement: (content) => (content.trim() ? `<${tag}>${content}</${tag}>` : content)
      });
    });
    // An <abbr>'s whole value is the title nobody can hover in a deck.
    td.addRule("abbrTitle", {
      filter: (node) => node.nodeName === "ABBR" && (node.getAttribute("title") || "").trim(),
      replacement: (content, node) => `${content} (${node.getAttribute("title").trim()})`
    });

    // <details>/<summary> is a disclosure widget, and Recall's importer reads
    // that exact markup as explicit FLASHCARD syntax — clipping an FAQ page
    // would offer to shred it into question/answer cards instead of keeping it
    // as notes. So flatten it deliberately: the summary becomes a bold lead-in
    // and the body follows as ordinary prose.
    td.addRule("disclosureSummary", {
      filter: "summary",
      replacement: (content) => {
        const text = content.replace(/\s+/g, " ").trim();
        return text ? `\n\n**${text}**\n\n` : "";
      }
    });
    td.addRule("disclosure", {
      filter: "details",
      replacement: (content) => {
        const body = content.trim();
        return body ? `\n\n${body}\n\n` : "";
      }
    });

    // Docs-site callouts (MkDocs, Docusaurus, Bootstrap alerts, GitHub-style
    // notes). Without a rule the label — "Warning", "Note" — becomes a stray
    // sentence and the box reads as an unremarkable paragraph. A blockquote is
    // the nearest thing Markdown has, and Recall renders it as one.
    const CALLOUT_SEL = ".admonition, .alert, .callout, .notice, .note-block, [role='note']";
    // Its label lives in a child of its own; bolding it here is what keeps
    // "Warning" reading as the callout's kind rather than as its first sentence.
    // Deliberately NOT part of CALLOUT_SEL — matching the title as a callout in
    // its own right made the container fail its own no-nested-callout guard, so
    // only the label was quoted and the body escaped the blockquote entirely.
    const CALLOUT_TITLE_SEL = ".admonition-title, .callout-title, .alert-heading, .notice-title, .admonition-heading";
    td.addRule("calloutTitle", {
      filter: (node) => node.nodeType === 1 && node.matches && node.matches(CALLOUT_TITLE_SEL),
      replacement: (content) => {
        const text = content.replace(/\s+/g, " ").trim();
        return text ? `\n\n**${text}**\n\n` : "";
      }
    });
    td.addRule("callout", {
      filter: (node) =>
        node.nodeType === 1 && node.matches && node.matches(CALLOUT_SEL) &&
        !node.querySelector(CALLOUT_SEL) && (node.textContent || "").trim().length > 0,
      replacement: (content) => {
        const body = content.trim().replace(/\n{3,}/g, "\n\n");
        if (!body) return "";
        return `\n\n${body.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n`;
      }
    });

    // SPA docs and design-system sites routinely build headings out of divs with
    // an ARIA role. Without this the clip has no heading structure at all — and
    // Recall's notes view promotes the shallowest heading to <h1>, so losing
    // them costs the whole outline and the table of contents with it.
    td.addRule("ariaHeading", {
      filter: (node) => node.nodeType === 1 && node.getAttribute &&
        node.getAttribute("role") === "heading" && !/^H[1-6]$/.test(node.nodeName),
      replacement: (content, node) => {
        const level = Math.min(6, Math.max(1, parseInt(node.getAttribute("aria-level") || "2", 10) || 2));
        const text = content.replace(/\s+/g, " ").trim();
        return text ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
      }
    });

    // Definition lists — API references, glossaries, spec pages. Turndown has no
    // rule, so <dt> and <dd> ran together into one unreadable paragraph. Markdown
    // has no definition list either; a bullet per term is the honest equivalent.
    td.addRule("definitionTerm", {
      filter: "dt",
      replacement: (content) => {
        const text = content.replace(/\s*\n\s*/g, " ").trim();
        return text ? `\n- **${text}**` : "";
      }
    });
    td.addRule("definitionDesc", {
      filter: "dd",
      replacement: (content, node) => {
        // A <dd> with no <dt> above it isn't a definition — it's the indentation
        // trick MediaWiki uses for a centred display equation, and dozens of
        // other sites use for a pull-quote. Gluing an em dash to the front of
        // one turns a formula into "— $$…$$".
        if (!hasDefinitionTerm(node)) return `\n\n${content.trim()}\n\n`;
        const text = content.replace(/\s*\n\s*/g, " ").trim();
        return text ? ` — ${text}` : "";
      }
    });
    td.addRule("definitionList", {
      filter: "dl",
      replacement: (content, node) => {
        const body = node.querySelector("dt")
          ? content.replace(/\n{2,}/g, "\n").trim()   // a real list: one line per term
          : content.trim();                            // an indent wrapper: leave its blocks alone
        return body ? `\n\n${body}\n\n` : "";
      }
    });

    // Embeds are removed by the sanitiser on both sides, but silently: a clipped
    // tutorial lost every video with no trace that one had been there. Leave the
    // link behind so the reference survives.
    td.addRule("embedLink", {
      filter: (node) => node.nodeName === "IFRAME",
      replacement: (_c, node) => {
        const src = absoluteUrl(node.getAttribute("src") || node.getAttribute("data-src") || "");
        if (!src || /^(?:about:|javascript:)/i.test(src)) return "";
        const title = (node.getAttribute("title") || "").trim();
        let label = title;
        if (!label) {
          try { label = new URL(src).hostname.replace(/^www\./, ""); } catch (_) { label = "embed"; }
        }
        return `\n\n[▶ ${label}](${src})\n\n`;
      }
    });

    // Turndown 7.1.2's built-in listItem rule always indents a list item's
    // second+ line by a hardcoded 4 spaces, regardless of how wide the marker
    // actually is. That only lines up for a single-digit ordered marker ("1.  "
    // is 4 chars); a two-digit one ("32.  " is 5 chars) leaves the continuation
    // one column short of the list's content column. marked/CommonMark then
    // stops treating it as part of the item — and a bare 4-space-indented line
    // at that point IS the syntax for an indented code block, so the paragraph
    // renders as inert grey code. Re-deriving the indent from the actual prefix
    // width fixes it for every marker size. (Ported from app.js.)
    td.addRule("list-item-indent-fix", {
      filter: "li",
      replacement: (content, node, options) => {
        content = content.replace(/^\n+/, "").replace(/\n+$/, "\n");
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

    // ---- Math ---------------------------------------------------------------
    // extractPageMath has already replaced every rendered widget, and
    // protectMathInDom every un-rendered "$…$", with a placeholder span carrying
    // the finished LaTeX. Emit it exactly as written — a replacement's return
    // value is never passed through the escaper, which is the whole point.
    td.addRule("raw-math", {
      filter: (node) => node.nodeName === "SPAN" && node.hasAttribute && node.hasAttribute(RAW_MATH_ATTR),
      replacement: (_c, node) => {
        const tex = node.getAttribute(RAW_MATH_ATTR);
        const isDisplay = tex.startsWith("$$") || tex.startsWith("\\[");
        return isDisplay ? `\n\n${tex}\n\n` : tex;
      }
    });

    // Safety nets for MathJax islands extractPageMath declined (a container it
    // could read no source from, or one injected after the clone was taken).
    // Same two rules Recall's own paste handler uses.
    td.addRule("mathjax-containers", {
      filter: (node) =>
        (node.classList && (node.classList.contains("MathJax") ||
          node.classList.contains("MathJax_Preview") ||
          node.classList.contains("MathJax_Display"))) ||
        node.nodeName === "MJX-CONTAINER",
      replacement: (_c, node) => {
        if (node.nodeName === "MJX-CONTAINER") {
          const copyText = node.querySelector("mjx-copytext");
          if (copyText) return copyText.textContent.trim();
        }
        return "";
      }
    });
    td.addRule("mathjax-script", {
      filter: (node) => node.nodeName === "SCRIPT" && node.type && node.type.startsWith("math/tex"),
      replacement: (_c, node) => {
        const tex = node.textContent.trim();
        return node.type.includes("mode=display") ? `\n$$\n${tex}\n$$\n` : `$${tex}$`;
      }
    });

    return td;
  }

  // Text going straight into a raw HTML tag we emit — it bypasses Turndown's
  // escaper, so it has to be safe on its own.
  function escapeInlineHtml(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Does this <dd>'s list actually define anything, or is <dl> just being used
  // as an indent wrapper (MediaWiki's display-equation trick)?
  function hasDefinitionTerm(node) {
    const list = node.parentElement;
    return Boolean(list && list.querySelector && list.querySelector("dt"));
  }

  // A page's <mark> is usually painted with a background colour; map it onto the
  // nearest of Recall's six named highlight colours so the tint survives, and
  // fall back to a bare <mark> (Recall's yellow) when it's anything else.
  //
  // Matched on HUE, not on RGB distance. A highlight is by definition a pale
  // wash of a colour, and pale washes are far from their saturated namesake in
  // RGB — Material's #c8e6c9 is 182 units from Recall's green, further than the
  // threshold any useful cutoff can sit at, yet nobody would call it anything
  // but green. Hue ignores how pale it is, which is exactly the property that
  // shouldn't matter here; the saturation floor is what keeps a grey or white
  // background from being assigned a colour it doesn't have.
  const MARK_HUES = { orange: 36, yellow: 54, green: 122, blue: 207, purple: 291, pink: 340 };
  const MARK_HUE_TOLERANCE = 25;
  const MARK_MIN_SATURATION = 0.12;

  function markColorName(node) {
    const raw = (node.getAttribute("data-color") || "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MARK_HUES, raw)) return raw;
    const style = node.getAttribute("style") || "";
    const match = /background(?:-color)?\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\))/i.exec(style);
    if (!match) return "";
    const rgb = parseColor(match[1]);
    if (!rgb) return "";
    const { hue, saturation } = hsl(rgb);
    if (saturation < MARK_MIN_SATURATION) return "";
    let best = "";
    let bestDistance = Infinity;
    for (const [name, target] of Object.entries(MARK_HUES)) {
      const raw = Math.abs(hue - target);
      const distance = Math.min(raw, 360 - raw);   // hue is a circle
      if (distance < bestDistance) { bestDistance = distance; best = name; }
    }
    return bestDistance <= MARK_HUE_TOLERANCE ? best : "";
  }

  function parseColor(value) {
    const rgb = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    let hex = value.replace("#", "");
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length < 6) return null;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  function hsl([r, g, b]) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    if (!delta) return { hue: 0, saturation: 0 };
    let hue;
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
    if (hue < 0) hue += 360;
    const lightness = (max + min) / 2 / 255;
    const saturation = delta / 255 / (1 - Math.abs(2 * lightness - 1) || 1);
    return { hue, saturation };
  }

  // Kept elements in document order, dropping any nested inside another kept
  // element and any that have since left the DOM.
  function topLevelKept() {
    const arr = orderedKeptEls().filter((el) => document.contains(el));
    return arr.filter((el) => !arr.some((other) => other !== el && other.contains(el)));
  }

  function stripHelpers(root) {
    root.querySelectorAll(`#${UI_ID}, #${OVERLAY_ID}`).forEach((n) => n.remove());
    return root;
  }

  // Split markdown into alternating prose / fenced-code segments, so the tidying
  // below can leave code exactly as the page wrote it. Collapsing blank lines and
  // trimming trailing whitespace inside a fence rewrites the snippet — two blank
  // lines separating two functions became one, and significant trailing spaces
  // vanished. Both are edits to the user's code that nothing asked for.
  function splitFences(md) {
    const parts = [];
    const fenceRe = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1?\2[ \t]*$/gm;
    let last = 0;
    let match;
    while ((match = fenceRe.exec(md))) {
      if (match.index > last) parts.push({ code: false, text: md.slice(last, match.index) });
      parts.push({ code: true, text: match[0] });
      last = fenceRe.lastIndex;
    }
    if (last < md.length) parts.push({ code: false, text: md.slice(last) });
    return parts;
  }

  function tidyProse(text) {
    return text
      .replace(/ /g, " ")
      // De-escape citation-style brackets Turndown escapes blindly (every [ → \[).
      // `\[1\]`, `\[1, 2\]`, `\[3-5\]` are literal text, never links, so the
      // backslashes are pure noise — restore the clean `[1]`. Scoped to numeric
      // citation shapes so real escaped brackets in prose stay escaped.
      .replace(/\\\[(\s*\d+[a-z]?(?:\s*[-–—,;]\s*\d+[a-z]?)*\s*)\\\]/gi, "[$1]")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  function tidyMarkdown(md) {
    const tidied = splitFences(md)
      .map((part) => (part.code ? part.text : tidyProse(part.text)))
      .join("")
      .trim();
    // Last: neutralise the dollar signs that are currency, not math. Recall's
    // renderer closes an inline "$…$" on any later "$" preceded by a non-space
    // character and scans up to 1000 chars to find one, so "…raised $100
    // million … priced at US$50…" swallowed the whole sentence between the two
    // amounts. See looksLikeMath in recall-math.js for where the line is drawn.
    return window.__recallMath ? window.__recallMath.escapeStrayDollars(tidied) : tidied;
  }

  // cloneNode(true) does not clone shadow roots, so anything a page renders
  // inside a web component (Lit, Stencil, most design-system docs) came back as
  // an empty custom element and the clip looked like it had failed. Walk the
  // subtree ourselves and splice each open shadow root's children into the
  // clone in its place. Closed roots are genuinely unreachable; nothing to do.
  function deepClone(el) {
    const clone = el.cloneNode(false);
    const roots = el.shadowRoot ? [el.shadowRoot, el] : [el];
    for (const root of roots) {
      for (const child of Array.from(root.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) clone.appendChild(deepClone(child));
        else clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }

  // Build the DOM to convert. Removed elements are stamped just for the clone
  // (so their descendants are dropped), then un-stamped immediately — the live
  // page is never left modified.
  function collectSourceHtml() {
    const container = document.createElement("div");
    const tops = topLevelKept();
    const removedEls = Array.from(removed.keys()).filter((el) => document.contains(el));
    removedEls.forEach((el) => el.setAttribute(REMOVE_ATTR, "1"));
    try {
      if (tops.length) {
        tops.forEach((el) => container.appendChild(deepClone(el)));
        container.querySelectorAll(`[${REMOVE_ATTR}]`).forEach((n) => n.remove());
        stripHelpers(container);
        scrubNoise(container);
        return { html: container, source: "picked" };
      }
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        for (let i = 0; i < sel.rangeCount; i++) container.appendChild(sel.getRangeAt(i).cloneContents());
        container.querySelectorAll(`[${REMOVE_ATTR}]`).forEach((n) => n.remove());
        stripHelpers(container);
        scrubNoise(container);
        return { html: container, source: "selection" };
      }
      // Smart Remove workflow: with nothing explicitly kept, whatever is LEFT on
      // the page after your deletions is the selection — clip the cleaned page.
      if (mode === "remove" && removedEls.length) {
        const bodyClone = deepClone(document.body);
        bodyClone.querySelectorAll(`[${REMOVE_ATTR}]`).forEach((n) => n.remove());
        stripHelpers(bodyClone);
        // Only here: the whole page is being taken, so its navigation, footer
        // and sidebars are certainly not what was meant. On the picked and
        // selection paths the user said exactly what they wanted and nothing
        // structural is second-guessed.
        stripPageChrome(bodyClone);
        scrubNoise(bodyClone);
        container.appendChild(bodyClone);
        return { html: container, source: "remaining" };
      }
      return { html: null, source: "none" };
    } finally {
      removedEls.forEach((el) => el.removeAttribute(REMOVE_ATTR));
    }
  }

  function convert() {
    lastMath = { captured: 0, missed: 0 };
    const { html, source } = collectSourceHtml();
    if (!html) return { markdown: "", source, tables: { html: 0, md: 0 }, math: lastMath };
    // Safe to reshape in place: collectSourceHtml hands back a detached clone.
    prepareGridTables(html);
    const tables = tableStats(html);
    // Formulas the page never rendered — plain "$x_k$" in a paragraph — are
    // lifted out of their text nodes here, so Turndown's escaper can't put
    // backslashes through them on the way past. scrubNoise has already dealt
    // with the rendered ones.
    if (window.__recallMath) window.__recallMath.protectMathInDom(html);
    let markdown = tidyMarkdown(buildTurndown().turndown(html));
    // Belt and braces: heals math that reached the markdown still escaped,
    // whatever shape the source markup was in. Same function Recall runs on its
    // own pasted notes, so paste and clip can never disagree.
    if (window.__recallMath) markdown = window.__recallMath.repairEscapedMathMarkdown(markdown);
    return { markdown, source, tables, math: lastMath };
  }

  // ---------------------------------------------------------------------------
  // Clipboard
  // ---------------------------------------------------------------------------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (_e) { return false; }
    }
  }

  // ---------------------------------------------------------------------------
  // Toolbar UI
  // ---------------------------------------------------------------------------
  const ui = document.createElement("div");
  ui.id = UI_ID;
  ui.innerHTML = `
    <div class="rc-bar">
      <span class="rc-logo" title="Double-click to move the bar to the bottom">Recall Clipper</span>
      <div class="rc-modes" role="group" aria-label="Pick mode">
        <button type="button" data-mode="select" class="rc-mode is-active" title="Press S · click blocks to KEEP them">➕ Select</button>
        <button type="button" data-mode="remove" class="rc-mode" title="Press R · click blocks to TRIM them out">🗑 Remove</button>
      </div>
      <span class="rc-count" data-count>0 kept</span>
      <div class="rc-actions">
        <button type="button" data-act="isolate" class="rc-toggle" aria-pressed="false" title="Hide everything on the page except your kept blocks (toggle)">🎯 Isolate</button>
        <button type="button" data-act="copy" class="rc-primary" title="Convert to Markdown and copy">Copy Markdown</button>
        <button type="button" data-act="preview" title="Show a rendered preview">Preview</button>
        <button type="button" data-act="clear" title="Restore the page & clear all picks">Clear</button>
        <button type="button" data-act="close" class="rc-close" title="Close (Esc)">✕</button>
      </div>
    </div>
    <div class="rc-hint">
      <b>Remove</b> (R): click parts to <b>delete</b> them from the page (<b>Ctrl+Z</b> undoes) ·
      <b>Select</b> (S): click blocks to keep — then <b>🎯 Isolate</b> hides the rest ·
      or just highlight text. <b>Clear</b> or close restores the page.
    </div>
    <div class="rc-panel" data-panel hidden>
      <div class="rc-panel-head">
        <div class="rc-tabs" role="group" aria-label="Preview mode">
          <button type="button" data-view="rendered" class="rc-tab is-active">Rendered</button>
          <button type="button" data-view="raw" class="rc-tab">Raw Markdown</button>
        </div>
        <span data-chars>0 chars</span>
        <button type="button" data-act="copy2" class="rc-primary">Copy</button>
        <button type="button" data-act="hidepanel">Hide</button>
      </div>
      <div class="rc-render" data-render></div>
      <textarea class="rc-raw" data-md spellcheck="false" readonly hidden></textarea>
      <div class="rc-note">Rendered with Recall's own engine — math (<code>$…$</code>), Mermaid/nomnoml diagrams and syntax highlighting appear exactly as they will in a deck. Equations are recovered as LaTeX from KaTeX, MathJax, Wikipedia and plain MathML. Tables become Markdown when the grid can hold them and sanitised HTML when they need merged or nested cells (Wikipedia infoboxes), so nothing is dropped either way.</div>
    </div>
    <div class="rc-toast" data-toast hidden></div>
  `;
  document.documentElement.appendChild(ui);

  const countEl = ui.querySelector("[data-count]");
  const isoBtn = ui.querySelector('[data-act="isolate"]');
  const panelEl = ui.querySelector("[data-panel]");
  const renderEl = ui.querySelector("[data-render]");
  const mdEl = ui.querySelector("[data-md]");
  const charsEl = ui.querySelector("[data-chars]");
  const toastEl = ui.querySelector("[data-toast]");
  let toastTimer = null;
  let lastMarkdown = "";
  let previewView = "rendered";

  function updateCount() {
    const k = kept.size, r = removed.size;
    // In Remove mode with no explicit keeps, the rest of the page is the pick.
    if (mode === "remove" && r && !k) { countEl.textContent = `${r} removed · rest auto-selected`; return; }
    countEl.textContent = r ? `${k} kept · ${r} removed` : `${k} kept`;
  }

  function toast(msg, ok = true) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.dataset.ok = ok ? "1" : "0";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  function setMode(next) {
    if (next !== "select" && next !== "remove") return;
    mode = next;
    ui.querySelectorAll(".rc-mode").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === next));
    ui.dataset.mode = next;
    updateCount();
    if (hoverEl) placeHover(hoverEl);
  }

  // Heavy preview libraries (KaTeX, Prism, mermaid, nomnoml) are injected only
  // the first time a preview is shown, so the common Copy path stays fast. The
  // background worker does the injecting (executeScript/insertCSS) on request.
  // Ask the background worker to re-read MathJax's source into the DOM (see
  // content/mathjax-source.js). It already ran once at activation; this catches
  // formulas typeset since — a lazily-loaded section, an SPA route change.
  // Always resolves: without it we still capture math, just from the MathML.
  function ensureMathSource() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "rc-stamp-math" }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (_) { resolve(); }
    });
  }

  let previewLibsPromise = null;
  function ensurePreviewLibs() {
    if (window.__rcPreviewLibsReady) return Promise.resolve(true);
    if (previewLibsPromise) return previewLibsPromise;
    previewLibsPromise = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "rc-load-preview-libs" }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) { previewLibsPromise = null; resolve(false); return; }
          window.__rcPreviewLibsReady = true;
          resolve(true);
        });
      } catch (_) { previewLibsPromise = null; resolve(false); }
    });
    return previewLibsPromise;
  }

  // Rendered view: run the clipped Markdown through the exact Recall pipeline
  // (recall-render.js) so the preview matches a deck. Degrades to plain marked,
  // then to raw text, if anything is missing.
  async function renderInto(md) {
    const R = window.__recallRender;
    if (R) {
      try {
        renderEl.innerHTML = R.markdownToSafeHtml(md);
        R.initMermaid();
        await R.enhanceRenderedMarkdown(renderEl);
        return;
      } catch (_) { /* fall through */ }
    }
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
      try {
        renderEl.innerHTML = DOMPurify.sanitize(marked.parse(md), { USE_PROFILES: { html: true } });
        return;
      } catch (_) { /* fall through */ }
    }
    renderEl.textContent = md;
  }

  function setPreviewView(view) {
    previewView = view === "raw" ? "raw" : "rendered";
    ui.querySelectorAll(".rc-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.view === previewView));
    const raw = previewView === "raw";
    mdEl.hidden = !raw;
    renderEl.hidden = raw;
  }

  async function showPreview(md) {
    lastMarkdown = md;
    mdEl.value = md;
    charsEl.textContent = `${md.length} chars`;
    panelEl.hidden = false;
    setPreviewView(previewView);
    renderEl.innerHTML = '<div class="rc-rendering">Rendering preview…</div>';
    await ensurePreviewLibs();
    await renderInto(md);
  }

  // "2 tables as HTML, 1 as Markdown · 14 formulas" — what the clip actually
  // did with the parts that have more than one possible answer, so it is never
  // something you have to infer from the output.
  function clipNote({ html, md }, math) {
    const parts = [];
    if (html || md) {
      const shapes = [];
      if (md) shapes.push(`${md} as Markdown`);
      if (html) shapes.push(`${html} as HTML`);
      const n = html + md;
      parts.push(`${n} table${n === 1 ? "" : "s"} ${shapes.join(", ")}`);
    }
    if (math.captured) parts.push(`${math.captured} formula${math.captured === 1 ? "" : "s"} as LaTeX`);
    // Say so out loud: a formula we couldn't read is the one thing in a clip
    // that needs checking by eye, and it looks like ordinary text otherwise.
    if (math.missed) parts.push(`${math.missed} formula${math.missed === 1 ? "" : "s"} had no readable source`);
    return parts.length ? ` · ${parts.join(" · ")}` : "";
  }

  async function doCopy() {
    await ensureMathSource();
    const { markdown, source, tables, math } = convert();
    if (!markdown) { toast("Nothing picked — click a block or highlight some text first.", false); return; }
    lastMarkdown = markdown;
    mdEl.value = markdown;
    charsEl.textContent = `${markdown.length} chars`;
    const ok = await copyText(markdown);
    const where = source === "selection" ? "highlighted text"
      : source === "remaining" ? "the cleaned page"
      : "picked blocks";
    toast(ok ? `Copied ${markdown.length} chars from ${where}${clipNote(tables, math)} → paste into a deck's Notes`
             : "Couldn't reach the clipboard — open Preview to copy manually.", ok);
  }

  ui.addEventListener("click", (e) => {
    const modeBtn = e.target.closest(".rc-mode");
    if (modeBtn) { setMode(modeBtn.dataset.mode); return; }
    const tabBtn = e.target.closest(".rc-tab");
    if (tabBtn) { setPreviewView(tabBtn.dataset.view); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "copy") doCopy();
    else if (act === "isolate") setIsolate(!isolateOn);
    else if (act === "preview") {
      ensureMathSource().then(() => {
        const { markdown } = convert();
        markdown ? showPreview(markdown) : toast("Nothing picked yet.", false);
      });
    }
    else if (act === "copy2") copyText(lastMarkdown).then((ok) => toast(ok ? "Copied." : "Copy failed.", ok));
    else if (act === "clear") clearAll();
    else if (act === "hidepanel") panelEl.hidden = true;
    else if (act === "close") destroy();
  });

  ui.querySelector(".rc-logo").addEventListener("dblclick", () => ui.classList.toggle("rc-docked-bottom"));

  // Cloze blanks reveal on tap in the preview, just like they do in a deck.
  renderEl.addEventListener("click", (e) => {
    const cloze = e.target.closest(".cloze");
    if (cloze) cloze.classList.toggle("is-revealed");
  });

  // ---------------------------------------------------------------------------
  // Wiring + teardown
  // ---------------------------------------------------------------------------
  const cap = true;
  document.documentElement.classList.add(ACTIVE_CLASS);
  window.addEventListener("mousemove", onMouseMove, cap);
  window.addEventListener("click", onClick, cap);
  window.addEventListener("pointerdown", onPointerDown, cap);
  window.addEventListener("keydown", onKeyDown, cap);
  setMode("select");
  rafId = requestAnimationFrame(tick);

  function destroy() {
    cancelAnimationFrame(rafId);
    window.removeEventListener("mousemove", onMouseMove, cap);
    window.removeEventListener("click", onClick, cap);
    window.removeEventListener("pointerdown", onPointerDown, cap);
    window.removeEventListener("keydown", onKeyDown, cap);
    clearTimeout(toastTimer);
    document.documentElement.classList.remove(ACTIVE_CLASS);
    // Put the live page back exactly as we found it: un-delete removed blocks
    // and undo any Isolate. The page is never left modified once we're off.
    Array.from(removed.keys()).forEach((el) => restoreLive(el, removed.get(el)));
    removed.clear();
    clearIsolation();
    // Defensive: ensure no stray marker attribute survives on the page.
    document.querySelectorAll(`[${REMOVE_ATTR}]`).forEach((n) => n.removeAttribute(REMOVE_ATTR));
    // The MAIN-world pass stamped every MathJax container with its source TeX
    // (content/mathjax-source.js). Those are ours too, and the page gets them
    // back exactly as it had them: without any.
    document.querySelectorAll("[data-recall-tex]").forEach((n) => {
      n.removeAttribute("data-recall-tex");
      n.removeAttribute("data-recall-tex-display");
    });
    overlay.remove();
    ui.remove();
    delete window.__recallClipper;
  }

  // `convert` is exposed alongside `destroy` so the conversion can be driven
  // headlessly (tools/convert.test.mjs) and inspected from the console without
  // going through the clipboard.
  window.__recallClipper = { destroy, convert };
  updateCount();
  toast("Recall Clipper on — Remove deletes blocks from the page (Ctrl+Z undoes), Select + 🎯 Isolate keeps only what you pick. Esc closes & restores.");
})();
