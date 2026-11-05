// Recall Web Clipper — page preparation for Save as PDF.
//
// Evaluated by pdf-job.js through the DevTools protocol, in an isolated
// world of its own (so the page's scripts cannot see or tamper with it), with
// cleaner-core.js evaluated just before it. It applies the popup's options to
// the live page, reports what the PDF needs to know, and — once the print is
// done — puts every change back. Each change pushes its own undo onto
// `journal`; restore() runs them newest first.

(() => {
  if (globalThis.__recallPdf) return;
  const core = globalThis.__recallCleanerCore;

  let journal = [];
  let picked = null;
  let startScroll = [0, 0];

  const undo = (fn) => journal.push(fn);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isUi = (el) => el && el.closest && el.closest("[data-recall-pdf-ui], [data-recall-cleaner-ui]");

  function setStyle(el, prop, value) {
    const hadAttr = el.hasAttribute("style");
    const before = el.style.getPropertyValue(prop);
    const prio = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value, "important");
    undo(() => {
      if (before) el.style.setProperty(prop, before, prio); else el.style.removeProperty(prop);
      // Back to no style attribute at all, not an empty one.
      if (!hadAttr && !el.getAttribute("style")) el.removeAttribute("style");
    });
  }
  function setAttr(el, name, value) {
    const had = el.hasAttribute(name);
    const before = el.getAttribute(name);
    if (value == null) el.removeAttribute(name); else el.setAttribute(name, value);
    undo(() => { if (had) el.setAttribute(name, before); else el.removeAttribute(name); });
  }
  function detach(el) {
    const parent = el.parentNode;
    if (!parent) return;
    const next = el.nextSibling;
    el.remove();
    undo(() => parent.insertBefore(el, next && next.parentNode === parent ? next : null));
  }
  function replace(el, withEl) {
    el.replaceWith(withEl);
    undo(() => withEl.replaceWith(el));
  }
  function addStyleSheet(css) {
    const style = document.createElement("style");
    style.setAttribute("data-recall-pdf-ui", "");
    style.textContent = css;
    (document.head || document.documentElement).append(style);
    undo(() => style.remove());
  }
  const style = (el) => { try { return getComputedStyle(el); } catch { return null; } };

  // ---------------------------------------------------------------- isolation

  // Hide everything that is not on the path from <body> to `keep`, and stop
  // the ancestors on that path from clipping it.
  function isolate(keep) {
    for (let node = keep; node && node !== document.body && node.parentElement; node = node.parentElement) {
      for (const sib of node.parentElement.children) {
        if (sib === node || /^(SCRIPT|STYLE|LINK|META)$/.test(sib.tagName) || isUi(sib)) continue;
        setStyle(sib, "display", "none");
      }
      const parent = node.parentElement;
      if (parent && parent !== document.documentElement) {
        setStyle(parent, "overflow", "visible");
        setStyle(parent, "height", "auto");
        setStyle(parent, "max-height", "none");
      }
    }
    setStyle(keep, "margin-top", "0");
  }

  function isolateSelection() {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) throw new Error("Select some of the page first, then save again.");
    const range = sel.getRangeAt(0);
    let anchor = range.commonAncestorContainer;
    if (anchor.nodeType !== 1) anchor = anchor.parentElement;
    anchor = anchor.closest("p, div, section, article, main, li, td, blockquote, figure, body") || document.body;
    const box = document.createElement("div");
    box.setAttribute("data-recall-pdf-selection", "");
    box.append(range.cloneContents());
    if (anchor === document.body) document.body.prepend(box);
    else anchor.parentNode.insertBefore(box, anchor);
    undo(() => box.remove());
    isolate(box);
  }

  // ---------------------------------------------------------------- page passes

  function clean(level) {
    if (!core || level === "off") return 0;
    const list = core.findCandidates(level);
    list.forEach(({ el }) => detach(el));
    const unlock = core.unlockScroll();
    undo(unlock);
    return list.length;
  }

  function expandCollapsed() {
    document.querySelectorAll("details:not([open])").forEach((d) => setAttr(d, "open", ""));
    // "Read more" truncation: line clamps and collapsed max-heights.
    document.querySelectorAll("[class*='collapsed'], [class*='truncate'], [class*='clamp'], [class*='read-more'], [class*='readmore']")
      .forEach((el) => {
        if (isUi(el) || el.querySelector("nav")) return;
        setStyle(el, "max-height", "none");
        setStyle(el, "-webkit-line-clamp", "unset");
        setStyle(el, "overflow", "visible");
      });
  }

  // Lazy images: promote data-src and friends, ask for eager loading, then
  // walk down the page so scroll-triggered loaders fire too.
  async function loadLazy(waitMs) {
    const LAZY = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-hi-res-src"];
    document.querySelectorAll("img").forEach((img) => {
      if (img.getAttribute("loading") === "lazy") setAttr(img, "loading", "eager");
      const lazy = LAZY.map((a) => img.getAttribute(a)).find(Boolean);
      const src = img.getAttribute("src") || "";
      if (lazy && (!src || src.startsWith("data:") || /placeholder|blank|spacer|lazy/i.test(src))) setAttr(img, "src", lazy);
      const lazySet = img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
      if (lazySet && !img.getAttribute("srcset")) setAttr(img, "srcset", lazySet);
    });
    document.querySelectorAll("source[data-srcset]").forEach((s) => {
      if (!s.getAttribute("srcset")) setAttr(s, "srcset", s.getAttribute("data-srcset"));
    });
    const step = Math.max(200, Math.round(innerHeight * 0.85));
    const started = Date.now();
    for (let y = 0; y < document.documentElement.scrollHeight && Date.now() - started < 15000; y += step) {
      scrollTo(0, y);
      await sleep(110);
    }
    scrollTo(0, document.documentElement.scrollHeight);
    await sleep(waitMs);
    scrollTo(startScroll[0], startScroll[1]);
    await waitForImages(6000);
  }

  function waitForImages(timeout) {
    const pending = [...document.images].filter((img) => !img.complete && img.getAttribute("src"));
    if (!pending.length) return Promise.resolve();
    return Promise.race([
      Promise.all(pending.map((img) => new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }))),
      sleep(timeout)
    ]);
  }

  // Fixed elements repeat on every printed page; sticky ones sit wherever the
  // page happened to be scrolled.
  function unfix() {
    for (const el of document.body.querySelectorAll("*")) {
      if (isUi(el)) continue;
      const s = style(el);
      if (!s) continue;
      if (s.position === "fixed") setStyle(el, "display", "none");
      else if (s.position === "sticky") setStyle(el, "position", "relative");
    }
  }

  function placeholderFor(el, kind) {
    const src = el.getAttribute("src") || (el.querySelector && el.querySelector("source") && el.querySelector("source").getAttribute("src")) || "";
    let url = "";
    try { url = src ? new URL(src, location.href).href : ""; } catch { url = src; }
    const label = el.getAttribute("title") || el.getAttribute("aria-label") || (url ? new URL(url, location.href).hostname : kind);
    const box = document.createElement("div");
    box.setAttribute("data-recall-pdf-ui", "");
    box.style.cssText = "border:1px solid #c9ced8;border-radius:6px;padding:10px 12px;margin:10px 0;font:13px/1.4 system-ui,sans-serif;color:#333;background:#f6f7f9;break-inside:avoid;";
    const strong = document.createElement("strong");
    strong.textContent = `▶ ${kind}: ${label}`;
    box.append(strong);
    if (url && !url.startsWith("blob:") && !url.startsWith("data:")) {
      box.append(document.createElement("br"));
      const a = document.createElement("a");
      a.href = url;
      a.textContent = url.length > 120 ? `${url.slice(0, 117)}…` : url;
      box.append(a);
    }
    return box;
  }

  function handleEmbeds(mode) {
    if (mode === "keep") return;
    const els = [...document.querySelectorAll("iframe, video, embed, object")].filter((el) => !isUi(el));
    for (const el of els) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 30) { setStyle(el, "display", "none"); continue; }
      if (mode === "hide") setStyle(el, "display", "none");
      else replace(el, placeholderFor(el, el.tagName === "VIDEO" ? "Video" : "Embedded content"));
    }
  }

  function handleImagesVisibility(o) {
    if (o.imageQuality === "none") {
      document.querySelectorAll("img, picture, video, canvas").forEach((el) => setStyle(el, "display", "none"));
      document.querySelectorAll("svg").forEach((el) => {
        if (!el.closest(".katex, mjx-container, .MathJax, math, .mermaid")) setStyle(el, "display", "none");
      });
      return;
    }
    if (o.minImagePx > 0) {
      document.querySelectorAll("img").forEach((img) => {
        const r = img.getBoundingClientRect();
        if (r.width > 0 && r.width < o.minImagePx && r.height < o.minImagePx) setStyle(img, "display", "none");
      });
    }
  }

  const luminance = (rgb) => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(rgb || "");
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) < 0.3) return null;
    return (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
  };

  function forceLight() {
    let n = 0;
    for (const el of [document.documentElement, document.body, ...document.body.querySelectorAll("*")]) {
      if (n > 6000) break;
      n += 1;
      if (isUi(el) || el.closest("pre, code, .katex, svg")) continue;
      const s = style(el);
      if (!s) continue;
      const bg = luminance(s.backgroundColor);
      if (bg != null && bg < 0.4) {
        setStyle(el, "background-color", "#ffffff");
        setStyle(el, "color", "#1a1a1a");
      } else {
        const fg = luminance(s.color);
        if (fg != null && fg > 0.75) setStyle(el, "color", "#1a1a1a");
      }
    }
    setStyle(document.documentElement, "background-color", "#ffffff");
    setStyle(document.body, "background-color", "#ffffff");
  }

  function extraCss(o) {
    const css = [];
    if (o.wrapCode) {
      css.push(`pre, pre code, code { white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
        pre { overflow: visible !important; max-height: none !important; }`);
    }
    if (o.avoidBreaks) {
      css.push(`img, svg, figure, pre, blockquote, table, tr, .katex-display, mjx-container[display="true"], li, h1, h2, h3, h4 { break-inside: avoid; page-break-inside: avoid; }
        h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
        p { orphans: 3; widows: 3; }`);
    }
    if (o.breakBefore !== "none") {
      const sel = o.breakBefore === "h1" ? "h1" : "h1, h2";
      css.push(`:is(${sel}) { break-before: page; page-break-before: always; }
        [data-recall-pdf-banner] + * :is(${sel}):first-of-type, body > :is(${sel}):first-child { break-before: auto; }`);
    }
    if (o.linkUrls) {
      css.push(`a[href^="http"]:not([data-recall-pdf-ui] a)::after { content: " (" attr(href) ")"; font-size: 0.8em; color: #555; overflow-wrap: anywhere; }`);
    }
    if (o.textSize !== 100) {
      // Text blocks only, and only the outermost of nested ones, so the zoom
      // never compounds and the page's columns, images and widths stay put.
      const TEXT = "p, li, dd, dt, td, th, blockquote, figcaption, pre, h1, h2, h3, h4, h5, h6, summary, caption";
      css.push(`:is(${TEXT}):not(:is(${TEXT}) *) { zoom: ${o.textSize / 100}; }`);
    }
    if (o.grayscale) css.push(`img, picture, video, canvas { filter: grayscale(1) !important; }`);
    if (o.imageQuality === "none") css.push(`* { background-image: none !important; }`);
    css.push(`img { max-width: 100% !important; height: auto; }`);
    addStyleSheet(css.join("\n"));
  }

  function banner(facts) {
    const box = document.createElement("div");
    box.setAttribute("data-recall-pdf-ui", "");
    box.setAttribute("data-recall-pdf-banner", "");
    box.style.cssText = "all:initial;display:block;box-sizing:border-box;margin:0 0 18px;padding:12px 14px;border:1px solid #d5d9e0;border-left:4px solid #4f5bd5;border-radius:6px;background:#f7f8fc;font:12px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#2b3140;break-inside:avoid;";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:700;font-size:15px;color:#151a26;margin-bottom:2px;";
    title.textContent = facts.title;
    const link = document.createElement("a");
    link.href = facts.url;
    link.textContent = facts.url;
    link.style.cssText = "color:#3946b8;word-break:break-all;";
    const line = document.createElement("div");
    const bits = [facts.site, facts.author && `by ${facts.author}`, facts.published && `published ${String(facts.published).slice(0, 10)}`,
      `saved ${new Date().toISOString().slice(0, 10)}`].filter(Boolean);
    line.textContent = bits.join(" · ");
    line.style.cssText = "color:#5b6476;";
    box.append(title, link, line);
    const host = document.querySelector("[data-recall-pdf-selection]") || picked;
    if (host && host.isConnected) host.prepend(box);
    else document.body.prepend(box);
    undo(() => box.remove());
  }

  // ---------------------------------------------------------------- images

  let imageSeq = 0;
  function collectImages(o, geo) {
    const settings = o.reencode;
    if (!settings) return [];
    const out = [];
    for (const img of document.images) {
      if (isUi(img) || !img.isConnected) continue;
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith("data:image/svg") || /\.svg(\?|#|$)/i.test(src)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || !img.naturalWidth) continue;
      const cssW = Math.min(r.width, geo.layoutWidthPx);
      const printedIn = (cssW * geo.scale) / 96;
      const targetW = Math.max(16, Math.round(printedIn * settings.dpi));
      const needsDownscale = img.naturalWidth > targetW * 1.15;
      if (!needsDownscale) continue;
      const w = Math.min(img.naturalWidth, targetW);
      const h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth));
      const id = `i${imageSeq += 1}`;
      setAttr(img, "data-recall-pdf-img", id);
      out.push({ id, src, width: w, height: h });
    }
    return out;
  }

  async function encode(blob, item, settings) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = item.width;
    canvas.height = item.height;
    const ctx = canvas.getContext("2d");
    const png = /png|gif|webp/.test(blob.type) && !/jpe?g/.test(blob.type);
    if (!png) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    if (settings.grayscale) ctx.filter = "grayscale(1)";
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close && bitmap.close();
    return canvas.toDataURL(png ? "image/png" : "image/jpeg", settings.jpeg / 100);
  }

  // Same-origin and CORS-open images can be re-encoded right here. The rest
  // go back to the background, which can fetch them with host permission.
  async function reencodeInPage(items, settings) {
    const failed = [];
    for (const item of items) {
      try {
        const res = await fetch(item.src, { mode: "cors" });
        if (!res.ok) throw new Error(String(res.status));
        swap(item.id, await encode(await res.blob(), item, settings));
      } catch {
        failed.push(item);
      }
    }
    return failed;
  }

  function swap(id, dataUrl) {
    const img = document.querySelector(`img[data-recall-pdf-img="${id}"]`);
    if (!img || !dataUrl) return false;
    const pic = img.parentElement && img.parentElement.tagName === "PICTURE" ? img.parentElement : null;
    if (pic) pic.querySelectorAll("source").forEach((s) => detach(s));
    setAttr(img, "srcset", null);
    setAttr(img, "sizes", null);
    setAttr(img, "src", dataUrl);
    return true;
  }

  function swapImages(results) {
    let n = 0;
    for (const { id, dataUrl } of results) if (swap(id, dataUrl)) n += 1;
    return waitForImages(4000).then(() => n);
  }

  // ---------------------------------------------------------------- pick

  function pickElement() {
    return new Promise((resolve, reject) => {
      const host = document.createElement("div");
      host.setAttribute("data-recall-pdf-ui", "");
      host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        .box{position:fixed;border:2px solid #4f5bd5;background:rgba(79,91,213,.12);pointer-events:none;border-radius:3px;display:none}
        .tip{position:fixed;left:50%;top:14px;transform:translateX(-50%);background:#1f2430;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
        kbd{font:11px ui-monospace,monospace;border:1px solid #6b7488;border-radius:4px;padding:0 4px}
      </style><div class="box"></div><div class="tip">Click the block to save as a PDF · <kbd>↑</kbd> wider · <kbd>↓</kbd> narrower · <kbd>Esc</kbd> cancel</div>`;
      const box = root.querySelector(".box");
      document.documentElement.append(host);
      let stack = [];
      const show = () => {
        const el = stack[stack.length - 1];
        if (!el) { box.style.display = "none"; return; }
        const r = el.getBoundingClientRect();
        Object.assign(box.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      };
      const done = (err) => {
        ["mousemove", "click", "mousedown", "keydown", "scroll"].forEach((ev) => removeEventListener(ev, handlers[ev], true));
        host.remove();
        if (err) reject(err); else { picked = stack[stack.length - 1]; resolve(true); }
      };
      const handlers = {
        mousemove: (e) => { if (e.target instanceof Element && stack[0] !== e.target) { stack = [e.target]; show(); } },
        mousedown: (e) => { e.preventDefault(); e.stopPropagation(); },
        click: (e) => { e.preventDefault(); e.stopPropagation(); if (!stack.length && e.target instanceof Element) stack = [e.target]; done(); },
        scroll: () => show(),
        keydown: (e) => {
          if (e.key === "Escape") { e.preventDefault(); done(new Error("cancelled")); }
          else if (e.key === "ArrowUp" && stack.length) { const p = stack[stack.length - 1].parentElement; if (p && p !== document.documentElement) stack.push(p); show(); e.preventDefault(); }
          else if (e.key === "ArrowDown" && stack.length > 1) { stack.pop(); show(); e.preventDefault(); }
          else if (e.key === "Enter" && stack.length) { e.preventDefault(); done(); }
        }
      };
      ["mousemove", "click", "mousedown", "keydown", "scroll"].forEach((ev) => addEventListener(ev, handlers[ev], true));
    });
  }

  // ---------------------------------------------------------------- smart page breaks
  //
  // Smart pages: instead of one page as tall as the whole site, the page is cut
  // into pages of about the chosen length, at the best place near each length:
  // before a heading if there is one, between two blocks otherwise, and never
  // through a picture, a table, a code block, a formula or a list item. Measured
  // while background.js lays the page out at its print width under print styles,
  // so the positions are the printed ones. The cuts can then be moved on the
  // page itself (editBreaks), and applyBreaks turns them into
  // `break-before: page`.

  const AVOID_INSIDE = "img, picture, svg, math, figure, pre, table, blockquote, li, dt, dd, video, canvas, iframe, "
    + ".katex, .katex-display, mjx-container, .MathJax, .mermaid, [data-recall-pdf-ui], [data-recall-cleaner-ui]";
  const BLOCKISH = /^(block|flow-root|list-item|flex|grid|table)$/;
  const HEADING = /^H[1-6]$/;
  const HEADING_SCORE = { H1: 5, H2: 4, H3: 3, H4: 2, H5: 2, H6: 2 };

  let plan = null; // { candidates: [{el, y, score}], breaks: [el], target, height, lengths }

  // One page's worth of geometry, read once: collectCandidates looks at each
  // element's neighbours many times over, and a long page has thousands.
  let cache = null;
  const rectOf = (el) => {
    if (!cache) return el.getBoundingClientRect();
    let r = cache.rects.get(el);
    if (!r) { r = el.getBoundingClientRect(); cache.rects.set(el, r); }
    return r;
  };
  const docTop = (el) => rectOf(el).top + scrollY;

  function laidOut(el) {
    let s;
    if (cache && cache.styles.has(el)) s = cache.styles.get(el);
    else {
      s = style(el);
      s = s && s.display !== "none" && s.visibility !== "hidden" && s.position !== "fixed" && s.position !== "absolute"
        ? { display: s.display, float: s.float !== "none" } : null;
      if (cache) cache.styles.set(el, s);
    }
    return s;
  }

  // The previous sibling that takes up room in the flow, if any.
  function previousInFlow(el) {
    for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
      if (isUi(p) || /^(SCRIPT|STYLE|LINK|META|TEMPLATE)$/.test(p.tagName)) continue;
      if (!laidOut(p)) continue;
      const r = rectOf(p);
      if (r.height === 0 && r.width === 0) continue;
      return p;
    }
    return null;
  }

  // A cut at the top of `el` is clean when nothing beside it on the way up to
  // <body> runs across that line: no column as wide as it, no float, no
  // picture or table. A narrower side column (a site's sidebar) does not stop
  // the cut — it is cut too, which costs far less than no cut at all.
  function cleanCutAt(el, y) {
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      const parent = node.parentElement;
      if (!parent) break;
      const siblings = parent.children;
      if (siblings.length > 400) return false; // a grid of hundreds: not a place to cut
      const width = rectOf(node).width;
      for (const sib of siblings) {
        if (sib === node || isUi(sib)) continue;
        const s = laidOut(sib);
        if (!s) continue;
        const r = rectOf(sib);
        if (r.height === 0) continue;
        // Something beside it that starts above the line and ends below it.
        if (r.top + scrollY >= y - 2 || r.bottom + scrollY <= y + 2) continue;
        if (s.float || r.width >= width * 0.75 || sib.matches(AVOID_INSIDE) || crossedInside(sib, y)) return false;
      }
    }
    return true;
  }

  // A picture, table or code block inside `box` that the line at `y` would cut.
  function crossedInside(box, y) {
    const items = box.querySelectorAll("img, picture, svg, table, figure, video, canvas, pre, iframe");
    for (let i = 0; i < items.length && i < 60; i += 1) {
      const r = rectOf(items[i]);
      if (r.height > 0 && r.top + scrollY < y - 2 && r.bottom + scrollY > y + 2) return true;
    }
    return items.length > 60;
  }

  function scoreOf(el) {
    if (HEADING.test(el.tagName)) return HEADING_SCORE[el.tagName];
    const first = el.firstElementChild;
    if (first && HEADING.test(first.tagName) && Math.abs(rectOf(first).top - rectOf(el).top) < 40) {
      return HEADING_SCORE[first.tagName];
    }
    if (/^(HR|SECTION|ARTICLE)$/.test(el.tagName)) return 2;
    return 1;
  }

  function collectCandidates() {
    cache = { rects: new Map(), styles: new Map() };
    try { return collectCandidatesNow(); } finally { cache = null; }
  }

  function collectCandidatesNow() {
    const height = measure().height;
    const byY = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (isUi(node)) return NodeFilter.FILTER_REJECT;
        if (node.matches(AVOID_INSIDE)) return NodeFilter.FILTER_REJECT;
        const s = laidOut(node);
        if (!s) return NodeFilter.FILTER_REJECT;
        return BLOCKISH.test(s.display) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    let n = 0;
    for (let el = walker.nextNode(); el && n < 20000; el = walker.nextNode()) {
      n += 1;
      const r = rectOf(el);
      if (r.height < 1 || r.width < 1) continue;
      const y = Math.round(r.top + scrollY);
      if (y < 24 || y > height - 24) continue;
      // Never leave a heading alone at the bottom of a page.
      const prev = previousInFlow(el);
      if (prev && HEADING.test(prev.tagName)) continue;
      const score = scoreOf(el);
      const had = byY.get(y);
      // Same line: keep the higher score; on a tie, the outer element (seen first).
      if (had && had.score >= score) continue;
      if (!cleanCutAt(el, y)) continue;
      byY.set(y, { el: had && had.score === score ? had.el : el, y, score });
    }
    return { height, candidates: [...byY.values()].sort((a, b) => a.y - b.y) };
  }

  // Greedy: from the top of each page, the best cut between 55% and 100% of the
  // page length — a heading beats a paragraph, a fuller page beats an emptier one.
  function chooseBreaks(candidates, height, target) {
    const breaks = [];
    let start = 0;
    let uncut = false;
    let guard = 0;
    while (height - start > target && guard < 2000) {
      guard += 1;
      let best = null;
      let bestValue = -Infinity;
      for (const c of candidates) {
        if (c.y <= start + target * 0.55) continue;
        if (c.y > start + target) break;
        const value = c.score + 1.5 * ((c.y - start) / target);
        if (value >= bestValue) { best = c; bestValue = value; }
      }
      if (!best) {
        // Nothing in the window: the last cut there is at all before the end
        // of the page, however short that leaves it.
        for (const c of candidates) {
          if (c.y <= start + 40) continue;
          if (c.y > start + target) break;
          best = c;
        }
      }
      if (!best) {
        // One block taller than a page (a giant picture or table): the print
        // cuts it where the paper ends.
        uncut = true;
        start += target;
        continue;
      }
      breaks.push(best.el);
      start = best.y;
    }
    return { breaks, uncut };
  }

  function chunkHeights(breaks, height) {
    const ys = breaks.map(docTop).sort((a, b) => a - b);
    const edges = [0, ...ys, height];
    const out = [];
    for (let i = 1; i < edges.length; i += 1) out.push(Math.max(1, Math.round(edges[i] - edges[i - 1])));
    return out;
  }

  function planReport() {
    const heights = chunkHeights(plan.breaks, plan.height);
    return { pages: heights.length, heights, uncut: plan.uncut, target: plan.target };
  }

  /** Plans the cuts for pages `target` layout pixels tall. */
  function planBreaks(target, lengths = {}) {
    const { height, candidates } = collectCandidates();
    const { breaks, uncut } = chooseBreaks(candidates, height, Math.max(200, target));
    plan = { candidates, breaks, uncut, target, height, lengths };
    return planReport();
  }

  /**
   * Shows the planned cuts on the page as dashed lines, to move before saving.
   * Click a line to remove it; click anywhere in the page to cut above that
   * point. Resolves with the final plan, or rejects "cancelled" (Esc).
   */
  function editBreaks() {
    if (!plan) throw new Error("no page breaks planned");
    return new Promise((resolve, reject) => {
      const host = document.createElement("div");
      host.setAttribute("data-recall-pdf-ui", "");
      host.style.cssText = "position:absolute;left:0;top:0;width:100%;height:0;z-index:2147483647;pointer-events:none;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        :host { all: initial; }
        .cut { position: absolute; left: 0; right: 0; height: 18px; margin-top: -9px; pointer-events: auto; cursor: pointer; }
        .cut::before { content: ""; position: absolute; left: 0; right: 0; top: 8px; border-top: 2px dashed #4f5bd5; }
        .cut:hover::before { border-top-color: #c62828; }
        .tag { position: absolute; right: 8px; top: -2px; font: 600 11px/1.6 system-ui, sans-serif; color: #fff;
          background: #4f5bd5; padding: 0 8px; border-radius: 999px; white-space: nowrap; }
        .cut:hover .tag { background: #c62828; }
        .cut:hover .tag::after { content: "  ✕ remove"; }
        .ghost { position: absolute; left: 0; right: 0; border-top: 2px dotted rgba(79,91,213,.55); pointer-events: none; display: none; }
        .bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); pointer-events: auto;
          display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: center;
          max-width: calc(100vw - 24px); box-sizing: border-box;
          background: #1f2430; color: #fff; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
          padding: 8px 10px; border-radius: 12px; box-shadow: 0 10px 28px rgba(0,0,0,.3); }
        .bar b { font-weight: 700; }
        .hint { color: #b8bfd0; font-size: 12px; }
        button, select { font: inherit; border-radius: 8px; border: 1px solid #4a5268; background: #2b3242; color: #fff; padding: 4px 10px; cursor: pointer; }
        button:hover { background: #374058; }
        button.go { background: #4f5bd5; border-color: #4f5bd5; font-weight: 650; }
        button.go:hover { background: #5e69e0; }
      </style>
      <div class="lines"></div>
      <div class="ghost"></div>
      <div class="bar" role="toolbar" aria-label="Page breaks">
        <span><b class="count"></b></span>
        <label class="hint">Page length <select class="length"></select></label>
        <span class="hint">Click a dashed line to remove it · click the page to cut there</span>
        <button type="button" class="reset">Reset</button>
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="go">Save PDF</button>
      </div>`;
      const lines = root.querySelector(".lines");
      const ghost = root.querySelector(".ghost");
      const count = root.querySelector(".count");
      const lengthSelect = root.querySelector(".length");
      const LABELS = { screen: "About one screen", a4: "About one A4 page", "2a4": "About two A4 pages", custom: "Custom" };
      for (const [key, px] of Object.entries(plan.lengths || {})) {
        const opt = document.createElement("option");
        opt.value = String(px);
        opt.textContent = LABELS[key] || key;
        if (px === plan.target) opt.selected = true;
        lengthSelect.append(opt);
      }
      if (!lengthSelect.options.length) lengthSelect.closest("label").remove();
      document.documentElement.append(host);
      const original = plan.breaks.slice();

      const paint = () => {
        const ys = plan.breaks.map((el) => ({ el, y: docTop(el) })).sort((a, b) => a.y - b.y);
        plan.breaks = ys.map((b) => b.el);
        lines.replaceChildren(...ys.map(({ el, y }, i) => {
          const cut = document.createElement("div");
          cut.className = "cut";
          cut.style.top = `${y}px`;
          cut.title = "Remove this page break";
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = `Page ${i + 2}`;
          cut.append(tag);
          cut.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            plan.breaks = plan.breaks.filter((b) => b !== el);
            paint();
          });
          return cut;
        }));
        const report = planReport();
        const longest = Math.max(...report.heights);
        count.textContent = `${report.pages} page${report.pages === 1 ? "" : "s"}${longest > plan.target * 1.05 ? " · some longer than the page length" : ""}`;
      };

      // Where a click in the page would cut: the nearest clean cut above it.
      const cutAbove = (y) => {
        let best = null;
        for (const c of plan.candidates) {
          if (c.y > y) break;
          best = c;
        }
        return best;
      };

      const finish = (err) => {
        removeEventListener("click", onClick, true);
        removeEventListener("mousedown", swallow, true);
        removeEventListener("mousemove", onMove, true);
        removeEventListener("keydown", onKey, true);
        host.remove();
        if (err) reject(err); else resolve(planReport());
      };
      const fromUi = (e) => e.composedPath().includes(host);
      const swallow = (e) => { if (!fromUi(e)) { e.preventDefault(); e.stopPropagation(); } };
      const onMove = (e) => {
        if (fromUi(e)) { ghost.style.display = "none"; return; }
        const c = cutAbove(e.clientY + scrollY);
        if (!c || plan.breaks.includes(c.el)) { ghost.style.display = "none"; return; }
        ghost.style.display = "block";
        ghost.style.top = `${c.y}px`;
      };
      const onClick = (e) => {
        if (fromUi(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const c = cutAbove(e.clientY + scrollY);
        if (!c || plan.breaks.includes(c.el)) return;
        plan.breaks.push(c.el);
        ghost.style.display = "none";
        paint();
      };
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(new Error("cancelled")); }
        else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(); }
      };
      root.querySelector(".go").addEventListener("click", () => finish());
      root.querySelector(".cancel").addEventListener("click", () => finish(new Error("cancelled")));
      root.querySelector(".reset").addEventListener("click", () => { plan.breaks = original.slice(); paint(); });
      lengthSelect.addEventListener("change", () => {
        const target = Number(lengthSelect.value);
        const { breaks, uncut } = chooseBreaks(plan.candidates, plan.height, target);
        Object.assign(plan, { breaks, uncut, target });
        paint();
      });
      addEventListener("click", onClick, true);
      addEventListener("mousedown", swallow, true);
      addEventListener("mousemove", onMove, true);
      addEventListener("keydown", onKey, true);
      paint();
      // Start where the first cut is, so the reader sees what this is about.
      if (plan.breaks.length) scrollTo(0, Math.max(0, docTop(plan.breaks[0]) - innerHeight * 0.6));
    });
  }

  /** Turns the planned cuts into page breaks; returns each page's content height. */
  function applyBreaks() {
    if (!plan) return { pages: 1, heights: [measure().height], uncut: false };
    plan.breaks.forEach((el) => {
      setStyle(el, "break-before", "page");
      setStyle(el, "page-break-before", "always");
    });
    plan.height = measure().height;
    const report = planReport();
    scrollTo(0, 0);
    return report;
  }

  // ---------------------------------------------------------------- entry points

  async function prepare(o, geo) {
    journal = [];
    startScroll = [scrollX, scrollY];
    const facts = core ? core.pageFacts() : { title: document.title, url: location.href, site: location.hostname };
    const report = { facts, cleaned: 0, images: [], resized: 0 };

    if (o.capture === "element") {
      if (!picked || !picked.isConnected) throw new Error("No block was picked.");
      isolate(picked);
    } else if (o.capture === "selection") {
      isolateSelection();
    }
    if (o.capture === "page" || o.capture === "visible") report.cleaned = clean(o.clean);
    else if (o.clean !== "off") core && undo(core.unlockScroll());
    if (o.expand) expandCollapsed();
    if (o.lazyLoad && o.capture !== "visible" && o.imageQuality !== "none") await loadLazy(o.lazyWaitMs);
    if (o.hideFixed && o.capture !== "visible") unfix();
    handleEmbeds(o.embeds);
    handleImagesVisibility(o);
    if (o.forceLight) forceLight();
    extraCss(o);
    if (o.banner && o.capture !== "visible") banner(facts);

    const before = document.title;
    document.title = facts.title;
    undo(() => { document.title = before; });

    const wanted = collectImages(o, geo);
    report.images = wanted.length ? await reencodeInPage(wanted, o.reencode) : [];
    report.resized = wanted.length - report.images.length;
    await waitForImages(3000);
    return report;
  }

  function measure() {
    const de = document.documentElement;
    const body = document.body;
    return {
      height: Math.ceil(Math.max(de.scrollHeight, body ? body.scrollHeight : 0, de.getBoundingClientRect().height)),
      width: Math.ceil(Math.max(de.scrollWidth, body ? body.scrollWidth : 0))
    };
  }

  function restore() {
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      try { journal[i](); } catch { /* the page moved on; keep restoring the rest */ }
    }
    journal = [];
    picked = null;
    plan = null;
    scrollTo(startScroll[0], startScroll[1]);
    return true;
  }

  globalThis.__recallPdf = {
    prepare, measure, restore, pickElement, swapImages, planBreaks, editBreaks, applyBreaks,
    facts: () => core && core.pageFacts()
  };
})();
