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
  // How tables are clipped. "auto" keeps grid-shaped tables as Markdown and
  // falls back to HTML only for the ones Markdown can't hold (spans, nesting);
  // "html" and "md" force one or the other. See the Tables section below.
  let tableMode = "auto";              // "auto" | "html" | "md"
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
    return { value: el.style.getPropertyValue("display"), priority: el.style.getPropertyPriority("display") };
  }
  function hideLive(el) { el.style.setProperty("display", "none", "important"); }
  function restoreLive(el, saved) {
    if (!saved) return;
    if (saved.value) el.style.setProperty("display", saved.value, saved.priority);
    else el.style.removeProperty("display");
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

  // Remove image-expand affordance text/buttons from a (cloned) subtree without
  // touching legitimate captions or the images themselves.
  function scrubNoise(root) {
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
  function bestImageUrl(img) {
    const src = img.getAttribute("src") || "";
    const lazy = img.getAttribute("data-src") || img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src") || "";
    let url = src;
    if (!url || /^data:image\/(gif|svg)/i.test(url) || url.startsWith("data:,")) url = lazy || src;
    if (!url && img.getAttribute("srcset")) url = img.getAttribute("srcset").split(",")[0].trim().split(" ")[0];
    return url;
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

  // Can this table survive the round-trip through a Markdown grid?
  function isGridTable(table) {
    if (table.querySelector("table")) return false;                       // nested
    for (const cell of table.querySelectorAll("th,td")) {
      if (spanOf(cell, "colspan") > 1 || spanOf(cell, "rowspan") > 1) return false;
    }
    return tableHasHeadingRow(table);
  }

  // Lay a table out as a rectangular grid, resolving colspan/rowspan into the
  // slots they actually occupy. grid[r][c] = { cell, primary } — `primary` marks
  // the one slot that owns the cell's content; the slots a span covers point at
  // the same cell so nothing is written into them twice.
  function tableGrid(table) {
    const grid = [];
    const at = (r) => (grid[r] || (grid[r] = []));
    Array.from(table.rows).forEach((tr, r) => {
      at(r);
      let c = 0;
      for (const cell of Array.from(tr.cells)) {
        while (at(r)[c]) c++;                       // skip slots a rowspan above took
        const cols = spanOf(cell, "colspan");
        const rows = spanOf(cell, "rowspan");
        for (let i = 0; i < rows; i++) {
          for (let j = 0; j < cols; j++) {
            at(r + i)[c + j] = { cell, primary: i === 0 && j === 0 };
          }
        }
        c += cols;
      }
    });
    return grid;
  }

  // Rebuild a table as a plain rectangle: every row the same width, a heading
  // row guaranteed (the GFM plugin refuses a table without one). Markdown has no
  // way to say "this cell spans two columns", so a spanned cell's content is
  // written once and the slots it covered are left empty — every value survives,
  // but the geometry is an approximation. That's the trade the Markdown mode is.
  function flattenTable(table) {
    const grid = tableGrid(table);
    const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
    if (!width || !grid.length) return null;
    const doc = table.ownerDocument;
    const out = doc.createElement("table");
    const thead = doc.createElement("thead");
    const tbody = doc.createElement("tbody");
    grid.forEach((row, r) => {
      const tr = doc.createElement("tr");
      for (let c = 0; c < width; c++) {
        const slot = row[c];
        const cell = doc.createElement(r === 0 ? "th" : "td");
        // Move (not copy) the content: each cell is primary in exactly one slot,
        // so this runs once per cell and can't duplicate a spanned value.
        if (slot && slot.primary) {
          while (slot.cell.firstChild) cell.appendChild(slot.cell.firstChild);
        }
        tr.appendChild(cell);
      }
      (r === 0 ? thead : tbody).appendChild(tr);
    });
    out.appendChild(thead);
    out.appendChild(tbody);
    return out;
  }

  // Innermost first, so a nested table is already a clean grid by the time its
  // parent lifts it into a cell.
  function flattenTables(root) {
    Array.from(root.querySelectorAll("table")).reverse().forEach((table) => {
      const flat = flattenTable(table);
      if (flat) table.replaceWith(flat);
    });
  }

  // Which way each table in the clip is about to go, so the UI can say so out
  // loud instead of leaving the user to guess from the output. Counts outermost
  // tables only — a nested one travels inside its parent, not on its own.
  function tableStats(root) {
    const stats = { html: 0, md: 0 };
    Array.from(root.querySelectorAll("table"))
      .filter((t) => !(t.parentElement && t.parentElement.closest("table")))
      .forEach((t) => {
        const asHtml = tableMode === "html" || (tableMode === "auto" && !isGridTable(t));
        stats[asHtml ? "html" : "md"]++;
      });
    return stats;
  }

  const TABLE_DROP = "script,style,noscript,iframe,canvas,svg,form,button,input,select,textarea,link,meta,object,embed";
  // Worth carrying into a deck: structure, plus the inline colours an infobox
  // paints its title bars with. Everything else (class, id, data-*, the page's
  // own JS hooks) is meaningless once the table is separated from its site.
  const TABLE_ATTR = /^(?:colspan|rowspan|scope|align|valign|style|alt|title|href|src)$/i;

  function serializeTable(table) {
    const clone = table.cloneNode(true);
    clone.querySelectorAll(TABLE_DROP).forEach((n) => n.remove());
    // The <table> itself included — querySelectorAll("*") only sees descendants,
    // which would leave the page's own class/id hooks on the root element.
    [clone, ...clone.querySelectorAll("*")].forEach((el) => {
      Array.from(el.attributes).forEach((a) => {
        if (!TABLE_ATTR.test(a.name)) el.removeAttribute(a.name);
      });
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

  function buildTurndown() {
    const td = new TurndownService({
      headingStyle: "atx", hr: "---", bulletListMarker: "-",
      codeBlockStyle: "fenced", fence: "```", emDelimiter: "*",
      strongDelimiter: "**", linkStyle: "inlined"
    });
    if (typeof turndownPluginGfm !== "undefined" && turndownPluginGfm.gfm) {
      td.use(turndownPluginGfm.gfm); // tables, strikethrough, task lists
    }
    // The GFM plugin emits single-tilde strikethrough (~x~); Recall's Markdown
    // renderer (marked) only recognises the double-tilde form, so override it.
    td.addRule("strikethrough", {
      filter: ["del", "s", "strike"],
      replacement: (content) => `~~${content}~~`
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

    // Tables → sanitised inline HTML: all of them under "html", and under "auto"
    // only the ones the Markdown grid can't hold. Under "md" the rule is left off
    // entirely and flattenTables (in convert) has already reshaped every table
    // into a grid the GFM plugin can take. Registered after the GFM plugin so it
    // wins over both its table rule and its raw-HTML `keep` fallback (Turndown
    // checks added rules before kept ones, most-recently-added first).
    if (tableMode !== "md") {
      td.addRule("complexTable", {
        filter: (node) => node.nodeName === "TABLE" &&
          (tableMode === "html" || !isGridTable(node)),
        replacement: (_c, node) => serializeTable(node)
      });
    }

    td.remove(["script", "style", "noscript", "iframe", "canvas", "svg", "form", "button", "input", "select", "textarea"]);

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

    td.addRule("katexDisplay", {
      filter: (node) => node.nodeType === 1 && node.classList && node.classList.contains("katex-display"),
      replacement: (_c, node) => {
        const tex = node.querySelector('annotation[encoding="application/x-tex"]');
        return tex ? `\n\n$$\n${tex.textContent.trim()}\n$$\n\n` : "";
      }
    });
    td.addRule("katexInline", {
      filter: (node) => node.nodeType === 1 && node.classList && node.classList.contains("katex")
        && !(node.parentNode && node.parentNode.classList && node.parentNode.classList.contains("katex-display")),
      replacement: (_c, node) => {
        const tex = node.querySelector('annotation[encoding="application/x-tex"]');
        return tex ? `$${tex.textContent.trim()}$` : "";
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
    return td;
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

  function tidyMarkdown(md) {
    return md
      .replace(/ /g, " ")
      // De-escape citation-style brackets Turndown escapes blindly (every [ → \[).
      // `\[1\]`, `\[1, 2\]`, `\[3-5\]` are literal text, never links, so the
      // backslashes are pure noise — restore the clean `[1]`. Scoped to numeric
      // citation shapes so real escaped brackets in prose stay escaped.
      .replace(/\\\[(\s*\d+[a-z]?(?:\s*[-–—,;]\s*\d+[a-z]?)*\s*)\\\]/gi, "[$1]")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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
        tops.forEach((el) => container.appendChild(el.cloneNode(true)));
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
        const bodyClone = document.body.cloneNode(true);
        bodyClone.querySelectorAll(`[${REMOVE_ATTR}]`).forEach((n) => n.remove());
        stripHelpers(bodyClone);
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
    const { html, source } = collectSourceHtml();
    if (!html) return { markdown: "", source, tables: { html: 0, md: 0 } };
    const tables = tableStats(html);              // before flattening rewrites them
    // Safe to reshape in place: collectSourceHtml hands back a detached clone.
    if (tableMode === "md") flattenTables(html);
    return { markdown: tidyMarkdown(buildTurndown().turndown(html)), source, tables };
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
      <label class="rc-tables" title="How to clip tables. Auto: Markdown when it fits, HTML when the table needs spans or nesting (Wikipedia infoboxes). HTML: always keep the exact layout. Markdown: always flatten to a Markdown grid.">
        Tables
        <select data-tables data-auto>
          <option value="auto">Auto</option>
          <option value="html">HTML — keep layout</option>
          <option value="md">Markdown — flatten</option>
        </select>
      </label>
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
      <div class="rc-note">Rendered with Recall's own engine — math (<code>$…$</code>), Mermaid/nomnoml diagrams and syntax highlighting appear exactly as they will in a deck. Tables with merged or nested cells (Wikipedia infoboxes) can't be expressed in Markdown, so they're kept as HTML — use the <b>Tables</b> control above to force one format or the other.</div>
    </div>
    <div class="rc-toast" data-toast hidden></div>
  `;
  document.documentElement.appendChild(ui);

  const countEl = ui.querySelector("[data-count]");
  const isoBtn = ui.querySelector('[data-act="isolate"]');
  const tablesSel = ui.querySelector("[data-tables]");
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

  const TABLE_MODE_NOTE = {
    auto: "Tables: Auto — simple tables become Markdown, spanned/nested ones (infoboxes) keep their layout as HTML.",
    html: "Tables: HTML — every table keeps its exact layout. Nothing is lost, but raw HTML shows in the Raw Markdown view.",
    md: "Tables: Markdown — every table is flattened to a Markdown grid. All values are kept; merged cells are approximated."
  };

  function setTableMode(next) {
    if (!Object.prototype.hasOwnProperty.call(TABLE_MODE_NOTE, next)) return;
    tableMode = next;
    if (tablesSel.value !== next) tablesSel.value = next;
    tablesSel.toggleAttribute("data-auto", next === "auto");  // highlights a forced choice
    toast(TABLE_MODE_NOTE[next]);
    // Re-clip so an open preview reflects the new choice immediately.
    if (!panelEl.hidden) {
      const { markdown } = convert();
      if (markdown) showPreview(markdown);
    }
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

  // "2 tables as HTML, 1 as Markdown" — so the format each table took is never
  // something you have to infer from the output.
  function tablesNote({ html, md }) {
    const parts = [];
    if (html) parts.push(`${html} as HTML`);
    if (md) parts.push(`${md} as Markdown`);
    if (!parts.length) return "";
    const n = html + md;
    return ` · ${n} table${n === 1 ? "" : "s"} ${parts.join(", ")}`;
  }

  async function doCopy() {
    const { markdown, source, tables } = convert();
    if (!markdown) { toast("Nothing picked — click a block or highlight some text first.", false); return; }
    lastMarkdown = markdown;
    mdEl.value = markdown;
    charsEl.textContent = `${markdown.length} chars`;
    const ok = await copyText(markdown);
    const where = source === "selection" ? "highlighted text"
      : source === "remaining" ? "the cleaned page"
      : "picked blocks";
    toast(ok ? `Copied ${markdown.length} chars from ${where}${tablesNote(tables)} → paste into a deck's Notes`
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
    else if (act === "preview") { const { markdown } = convert(); markdown ? showPreview(markdown) : toast("Nothing picked yet.", false); }
    else if (act === "copy2") copyText(lastMarkdown).then((ok) => toast(ok ? "Copied." : "Copy failed.", ok));
    else if (act === "clear") clearAll();
    else if (act === "hidepanel") panelEl.hidden = true;
    else if (act === "close") destroy();
  });

  tablesSel.addEventListener("change", () => setTableMode(tablesSel.value));

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
    overlay.remove();
    ui.remove();
    delete window.__recallClipper;
  }

  window.__recallClipper = { destroy };
  updateCount();
  toast("Recall Clipper on — Remove deletes blocks from the page (Ctrl+Z undoes), Select + 🎯 Isolate keeps only what you pick. Esc closes & restores.");
})();
