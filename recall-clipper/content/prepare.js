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
    if (!o.effects) css.push(`*, *::before, *::after { box-shadow: none !important; text-shadow: none !important; }`);
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
  //
  // Chrome's PDF backend keeps a JPEG as it is, but stores every other picture
  // — WebP, AVIF, PNG, GIF — as its raw pixels, deflated: a 3000 px WebP photo
  // becomes megabytes, and every reader has to decode all of it to draw a
  // page. So every raster picture the print shows is listed here with the size
  // it prints at; pdf-job.js reads its bytes through the debugger (no host
  // permission, no CORS), re-encodes it at that size in the service worker, and
  // swapImages puts it back as a blob: URL — one per distinct picture, so a
  // picture used twice is read, re-encoded and handed over once.

  let imageSeq = 0;
  let blobUrls = [];

  const RASTER_SKIP = /^data:image\/svg|\.svg(\?|#|$)/i;

  // The url() of a single-layer background image, or null.
  function backgroundUrl(value) {
    if (!value || value === "none" || value.includes("gradient(")) return null;
    const urls = [...value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g)];
    if (urls.length !== 1) return null;
    const raw = (urls[0][1] ?? urls[0][2] ?? urls[0][3] ?? "").trim();
    try { return new URL(raw, document.baseURI).href; } catch { return null; }
  }

  function collectImages(o) {
    if (o.imageQuality === "none") return [];
    const out = [];
    for (const img of document.images) {
      if (isUi(img) || !img.isConnected) continue;
      const src = img.currentSrc || img.src;
      if (!src || RASTER_SKIP.test(src) || src.startsWith("blob:")) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || !img.naturalWidth) continue;
      const id = `i${imageSeq += 1}`;
      setAttr(img, "data-recall-pdf-img", id);
      out.push({ id, kind: "img", src, cssWidth: r.width, cssHeight: r.height, fit: "fill", naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight });
    }
    // Large CSS backgrounds (hero pictures). Only those sized by the box —
    // cover, contain or a length — since an `auto` size is the picture's own
    // pixel size, which a smaller copy would change.
    let n = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if ((n += 1) > 8000) break;
      if (isUi(el)) continue;
      const s = style(el);
      if (!s || s.backgroundImage === "none") continue;
      const src = backgroundUrl(s.backgroundImage);
      if (!src || RASTER_SKIP.test(src) || src.startsWith("blob:")) continue;
      const size = s.backgroundSize.trim();
      if (!size || /^auto(\s+auto)?$/.test(size)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      const id = `b${imageSeq += 1}`;
      setAttr(el, "data-recall-pdf-img", id);
      const fit = size === "cover" ? "cover" : size === "contain" ? "contain" : "fill";
      out.push({ id, kind: "bg", src, cssWidth: r.width, cssHeight: r.height, fit });
    }
    return out;
  }

  function swapOne(id, url) {
    const el = document.querySelector(`[data-recall-pdf-img="${id}"]`);
    if (!el) return false;
    if (el.tagName === "IMG") {
      const pic = el.parentElement && el.parentElement.tagName === "PICTURE" ? el.parentElement : null;
      if (pic) pic.querySelectorAll("source").forEach((s) => detach(s));
      setAttr(el, "srcset", null);
      setAttr(el, "sizes", null);
      setAttr(el, "src", url);
    } else {
      setStyle(el, "background-image", `url("${url}")`);
    }
    return true;
  }

  /** results: [{ ids: [id], type, b64 }] — one smaller copy each, for every element that showed it. */
  function swapImages(results) {
    let n = 0;
    for (const { ids, type, b64 } of results) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      blobUrls.push(url);
      for (const id of ids) if (swapOne(id, url)) n += 1;
    }
    return waitForImages(4000).then(() => n);
  }

  // ---------------------------------------------------------------- effects & fonts

  // A blurred shadow or filter cannot be drawn in PDF: Chrome paints each one
  // into a picture of its own at 300 DPI (a page of cards can carry hundreds).
  // Shadows go in the extra stylesheet; blur and drop-shadow filters, here,
  // leaving filters such as an icon's invert() as they are.
  function stripEffects(o) {
    let n = 0;
    for (const el of document.body.querySelectorAll("*")) {
      if ((n += 1) > 20000) break;
      if (isUi(el)) continue;
      const s = style(el);
      if (!s) continue;
      if (/blur\(|drop-shadow\(/.test(s.filter)) {
        const keep = o.grayscale && /^(IMG|PICTURE|VIDEO|CANVAS)$/.test(el.tagName) ? "grayscale(1)" : "none";
        setStyle(el, "filter", keep);
      }
      const backdrop = s.backdropFilter || s.webkitBackdropFilter || "";
      if (backdrop && backdrop !== "none") {
        setStyle(el, "backdrop-filter", "none");
        setStyle(el, "-webkit-backdrop-filter", "none");
      }
    }
  }

  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong|-apple-system|blinkmacsystemfont)$/i;
  const ICON_FONT = /icon|awesome|material|symbol|glyph|^fa[\s-]|ionic|dashicons|feather|lucide|codicon|bootstrap-icons/i;
  const familyList = (value) => String(value || "").split(",").map((f) => f.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

  /**
   * Prints text in `families` (variable fonts, which Chrome can only embed as
   * slow, blurry Type 3 fonts) in the page's own fallback font instead. With
   * `all`, every web font goes, except monospace and icon fonts. Returns how
   * many elements changed.
   */
  function replaceFonts(families, all = false) {
    const drop = new Set((families || []).map((f) => f.toLowerCase()));
    if (!drop.size && !all) return 0;
    const changes = [];
    let n = 0;
    for (const el of [document.body, ...document.body.querySelectorAll("*")]) {
      if ((n += 1) > 30000) break;
      if (isUi(el) || /^(SCRIPT|STYLE|SVG|svg|MATH|math)$/.test(el.tagName) || el.closest(".katex, mjx-container, .MathJax, svg, math")) continue;
      const s = style(el);
      if (!s) continue;
      const parent = el.parentElement && style(el.parentElement);
      // Only where a font is declared: the rest inherit the change.
      if (parent && parent.fontFamily === s.fontFamily && el !== document.body) continue;
      const list = familyList(s.fontFamily);
      if (!list.length) continue;
      if (list.some((f) => /monospace|mono\b|code|courier|consol/i.test(f)) || list.some((f) => ICON_FONT.test(f))) continue;
      const kept = list.filter((f) => GENERIC.test(f) || (!all && !drop.has(f.toLowerCase())));
      if (kept.length === list.length) continue;
      if (!kept.some((f) => GENERIC.test(f))) kept.push(/serif/i.test(s.fontFamily) && !/sans/i.test(s.fontFamily) ? "serif" : "sans-serif");
      changes.push([el, kept.map((f) => (GENERIC.test(f) ? f : `"${f}"`)).join(", ")]);
    }
    changes.forEach(([el, value]) => setStyle(el, "font-family", value));
    return changes.length;
  }

  // ---------------------------------------------------------------- PDF markers
  //
  // Chrome writes a named destination, with its exact printed page and
  // position, for every element an in-page link points at — even a link in a
  // box nobody sees. pdf-job.js reads them back: headings become bookmarks
  // (lib/pdf-outline.js) without a tagged PDF, and each smart page is trimmed
  // to exactly where its content ends (lib/pdf-pages.js).

  let linkBox = null;
  function linkTo(id) {
    if (!linkBox) {
      linkBox = document.createElement("div");
      linkBox.setAttribute("data-recall-pdf-ui", "");
      linkBox.style.cssText = "display:none !important";
      document.body.append(linkBox);
      const box = linkBox;
      undo(() => { box.remove(); if (linkBox === box) linkBox = null; });
    }
    const a = document.createElement("a");
    a.href = `#${id}`;
    linkBox.append(a);
  }

  function marker(id, block) {
    const m = document.createElement(block ? "div" : "span");
    m.id = id;
    m.setAttribute("data-recall-pdf-ui", "");
    m.setAttribute("aria-hidden", "true");
    m.style.cssText = block
      ? "display:block !important;height:0 !important;margin:0 !important;padding:0 !important;border:0 !important;clear:both !important;"
      : "";
    return m;
  }

  /** Gives each heading a destination; returns [{ id, level, text }] in reading order. */
  function markHeadings() {
    const out = [];
    for (const h of document.body.querySelectorAll("h1, h2, h3, h4")) {
      if (isUi(h) || out.length >= 2000) continue;
      const s = style(h);
      if (!s || s.display === "none" || s.visibility === "hidden") continue;
      const r = h.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const text = (h.innerText || h.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const id = `recall-h-${out.length}`;
      const m = marker(id, false);
      h.prepend(m);
      undo(() => m.remove());
      linkTo(id);
      out.push({ id, level: Number(h.tagName[1]), text: text.slice(0, 200) });
    }
    return out;
  }

  const BLOCK_FLOW = /^(block|flow-root|list-item)$/;

  // An empty block where page `i`'s content ends: just before `next` (the first
  // block of the following page), or at the end of the page. Placed only where
  // it sits in normal block flow — between a flex or grid container's items it
  // would take up room — and never between list items or table rows, where it
  // would shift the counting. Without one, the page keeps its measured height.
  function markPageEnd(i, next) {
    let at = next;
    if (at) {
      const top = rectOf(at).top;
      while (at && at.parentElement && at.parentElement !== document.documentElement) {
        const ps = style(at.parentElement);
        if (ps && BLOCK_FLOW.test(ps.display) && !/^(LI|TR|TD|TH|DT|DD)$/.test(at.tagName)) break;
        const up = at.parentElement;
        if (Math.abs(rectOf(up).top - top) > 2) return false;
        at = up;
      }
      if (!at || !at.parentElement) return false;
    } else {
      const bs = style(document.body);
      if (!bs || !BLOCK_FLOW.test(bs.display)) return false;
    }
    const id = `recall-end-${i}`;
    const m = marker(id, true);
    if (at) at.parentElement.insertBefore(m, at); else document.body.append(m);
    undo(() => m.remove());
    linkTo(id);
    return true;
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
  // before a heading if there is one, between two blocks otherwise, between two
  // list items or table rows in a list or table longer than a page, and never
  // through a picture, a code block or a formula. Measured while pdf-job.js
  // lays the page out at its print width under print styles, so the positions
  // are the printed ones. The cuts can then be moved on the page itself
  // (editBreaks), and applyBreaks turns them into `break-before: page`.
  //
  // Every block top is a candidate. A "clean" one is where nothing beside it
  // runs across the line; those are what the planner and a snap use. The rest
  // are still there for the editor, with Alt held.

  // Never cut inside these.
  const ATOMIC = "img, picture, svg, math, figure, pre, video, canvas, iframe, "
    + ".katex, .katex-display, mjx-container, .MathJax, .mermaid, [data-recall-pdf-ui], [data-recall-cleaner-ui]";
  // A cut may go between their items, never inside one.
  const ITEM = /^(LI|DT|DD|TR)$/;
  // What must not run across a cut beside it.
  const NOT_BESIDE = `${ATOMIC}, table, blockquote, li, dt, dd`;
  const BLOCKISH = /^(block|flow-root|list-item|flex|grid|table|table-row)$/;
  const HEADING = /^H[1-6]$/;
  const HEADING_SCORE = { H1: 5, H2: 4, H3: 3, H4: 2, H5: 2, H6: 2 };

  let plan = null; // { candidates: [{el, y, score, clean}], clean: [...], breaks: [el], target, height, lengths, uncut }

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
      if (siblings.length > 400 && !ITEM.test(node.tagName)) return false; // a grid of hundreds: not a place to cut
      const width = rectOf(node).width;
      if (siblings.length > 400) continue; // a long list: its items never sit beside each other
      for (const sib of siblings) {
        if (sib === node || isUi(sib)) continue;
        const s = laidOut(sib);
        if (!s) continue;
        const r = rectOf(sib);
        if (r.height === 0) continue;
        // Something beside it that starts above the line and ends below it.
        if (r.top + scrollY >= y - 2 || r.bottom + scrollY <= y + 2) continue;
        if (s.float || r.width >= width * 0.75 || sib.matches(NOT_BESIDE) || crossedInside(sib, y)) return false;
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
    if (ITEM.test(el.tagName)) return 0.5;
    const first = el.firstElementChild;
    if (first && HEADING.test(first.tagName) && Math.abs(rectOf(first).top - rectOf(el).top) < 40) {
      return HEADING_SCORE[first.tagName];
    }
    if (/^(HR|SECTION|ARTICLE)$/.test(el.tagName)) return 2;
    return 1;
  }

  // A table row a cut may go before: a body row, not the first one (which
  // would leave the header alone).
  function cuttableRow(tr) {
    const table = tr.closest("table");
    if (!table || /^(THEAD|TFOOT)$/.test(tr.parentElement.tagName)) return false;
    const firstBody = [...table.rows].find((r) => !/^(THEAD|TFOOT)$/.test(r.parentElement.tagName));
    return firstBody !== tr;
  }

  // A table cut between its rows prints its header row again at the top of
  // the next page: how tall that is, in layout pixels.
  function repeatedHeader(tr) {
    const table = tr.closest("table");
    const head = table && table.tHead;
    const s = head && style(head);
    return s && s.display === "table-header-group" ? Math.ceil(rectOf(head).height) : 0;
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
        if (isUi(node) || node.matches(ATOMIC)) return NodeFilter.FILTER_REJECT;
        // Inside a list item or a table cell: never.
        const item = node.parentElement && node.parentElement.closest("li, dt, dd, td, th, blockquote");
        if (item && item !== document.body) return NodeFilter.FILTER_REJECT;
        const s = laidOut(node);
        if (!s) return NodeFilter.FILTER_REJECT;
        if (node.tagName === "TR" && !cuttableRow(node)) return NodeFilter.FILTER_SKIP;
        return BLOCKISH.test(s.display) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    const better = (a, b) => (a.clean !== b.clean ? a.clean : a.score > b.score);
    let n = 0;
    for (let el = walker.nextNode(); el && n < 30000; el = walker.nextNode()) {
      n += 1;
      const r = rectOf(el);
      if (r.height < 1 || r.width < 1) continue;
      const y = Math.round(r.top + scrollY);
      if (y < 24 || y > height - 24) continue;
      // A heading left alone at the bottom of a page is never clean.
      const prev = previousInFlow(el);
      const clean = !(prev && HEADING.test(prev.tagName)) && cleanCutAt(el, y);
      const c = { el, y, score: scoreOf(el), clean, extra: el.tagName === "TR" ? repeatedHeader(el) : 0 };
      const had = byY.get(y);
      // Same line: the clean one, then the higher score; on a tie, the outer element (seen first).
      if (had && !better(c, had)) continue;
      byY.set(y, c);
    }
    const candidates = [...byY.values()].sort((a, b) => a.y - b.y);
    return { height, candidates, clean: candidates.filter((c) => c.clean) };
  }

  // Greedy: from the top of each page, the best clean cut between 55% and 100%
  // of the page length — a heading beats a paragraph, a paragraph beats a list
  // item, a fuller page beats an emptier one.
  function chooseBreaks(candidates, height, target) {
    const breaks = [];
    let start = 0;
    let room = target; // less on a page that starts with a repeated table header
    let uncut = false;
    let guard = 0;
    while (height - start > room && guard < 2000) {
      guard += 1;
      let best = null;
      let bestValue = -Infinity;
      for (const c of candidates) {
        if (c.y <= start + room * 0.55) continue;
        if (c.y > start + room) break;
        const value = c.score + 1.5 * ((c.y - start) / room);
        if (value >= bestValue) { best = c; bestValue = value; }
      }
      if (!best) {
        // Nothing in the window: the last cut there is at all before the end
        // of the page, however short that leaves it.
        for (const c of candidates) {
          if (c.y <= start + 40) continue;
          if (c.y > start + room) break;
          best = c;
        }
      }
      if (!best) {
        // One block taller than a page (a giant picture or table): the print
        // cuts it where the paper ends.
        uncut = true;
        start += room;
        room = target;
        continue;
      }
      breaks.push(best.el);
      start = best.y;
      room = Math.max(200, target - (best.extra || 0));
    }
    return { breaks, uncut };
  }

  const yOf = (el) => {
    const c = plan && plan.byEl && plan.byEl.get(el);
    return c ? c.y : docTop(el);
  };

  function chunkHeights(breaks, height) {
    const ys = breaks.map(yOf).sort((a, b) => a - b);
    const edges = [0, ...ys, height];
    const out = [];
    for (let i = 1; i < edges.length; i += 1) out.push(Math.max(1, Math.round(edges[i] - edges[i - 1])));
    return out;
  }

  function planReport() {
    const heights = chunkHeights(plan.breaks, plan.height);
    return { pages: heights.length, heights, uncut: plan.uncut, target: plan.target, markers: plan.markers || [] };
  }

  /** Plans the cuts for pages `target` layout pixels tall. */
  function planBreaks(target, lengths = {}) {
    const { height, candidates, clean } = collectCandidates();
    const { breaks, uncut } = chooseBreaks(clean, height, Math.max(200, target));
    plan = { candidates, clean, byEl: new Map(candidates.map((c) => [c.el, c])), breaks, uncut, target, height, lengths };
    return planReport();
  }

  // The candidate nearest `y` in a list sorted by y, leaving out `skip`.
  function nearest(list, y, skip) {
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].y < y) lo = mid + 1; else hi = mid;
    }
    let best = null;
    for (let i = Math.max(0, lo - 3); i < Math.min(list.length, lo + 3); i += 1) {
      const c = list[i];
      if (skip && skip.has(c.el)) continue;
      if (!best || Math.abs(c.y - y) < Math.abs(best.y - y)) best = c;
    }
    // Far apart: widen the search past the skipped ones.
    if (!best) for (const c of list) if (!skip || !skip.has(c.el)) if (!best || Math.abs(c.y - y) < Math.abs(best.y - y)) best = c;
    return best;
  }

  // The candidate before or after `y` (dir −1 / +1), leaving out `skip`.
  function stepFrom(list, y, dir, skip) {
    if (dir > 0) { for (const c of list) if (c.y > y + 1 && !skip.has(c.el)) return c; }
    else for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].y < y - 1 && !skip.has(list[i].el)) return list[i];
    return null;
  }

  /**
   * Shows the planned cuts on the page, to change before saving. Drag a cut to
   * move it (it snaps to the nearest clean place; hold Alt for any block);
   * click the page to add one; ✕ removes one. Undo/Redo, Auto (plan again),
   * and a page length. Resolves with the final plan, or rejects "cancelled" (Esc).
   */
  function editBreaks() {
    if (!plan) throw new Error("no page breaks planned");
    return new Promise((resolve, reject) => {
      const host = document.createElement("div");
      host.setAttribute("data-recall-pdf-ui", "");
      host.style.cssText = `position:absolute;left:0;top:0;width:100%;height:${plan.height}px;z-index:2147483647;pointer-events:none;`;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>
        :host { all: initial; }
        .band { position: absolute; left: 0; right: 0; pointer-events: none; box-sizing: border-box; }
        .band.odd { background: rgba(79,91,213,.045); }
        .band.long { background: rgba(245,158,11,.10); box-shadow: inset 4px 0 0 #f59e0b; }
        .label { position: absolute; right: 8px; top: 6px; font: 600 11px/1.6 system-ui, sans-serif; color: #3946b8;
          background: rgba(255,255,255,.92); border: 1px solid #c9cef5; padding: 0 8px; border-radius: 999px; white-space: nowrap; }
        .band.long .label { color: #8a4b00; border-color: #f5c37a; }
        .cut { position: absolute; left: 0; right: 0; height: 16px; margin-top: -8px; pointer-events: auto; cursor: ns-resize; touch-action: none; }
        .cut::before { content: ""; position: absolute; left: 0; right: 0; top: 7px; border-top: 2px dashed #4f5bd5; }
        .cut:hover::before, .cut.sel::before { border-top: 2px solid #4f5bd5; }
        .cut.drag::before { border-top: 2px solid #c2410c; }
        .grip { position: absolute; left: 8px; top: -3px; display: flex; align-items: center; gap: 4px; height: 20px; padding: 0 4px 0 8px;
          font: 600 11px/20px system-ui, sans-serif; color: #fff; background: #4f5bd5; border-radius: 999px; white-space: nowrap; user-select: none; }
        .cut.drag .grip { background: #c2410c; }
        .grip .x { all: unset; cursor: pointer; width: 16px; height: 16px; line-height: 16px; text-align: center; border-radius: 50%; font-size: 12px; }
        .grip .x:hover { background: rgba(255,255,255,.25); }
        .ghost, .limit { position: absolute; left: 0; right: 0; pointer-events: none; display: none; }
        .ghost { border-top: 2px dotted rgba(79,91,213,.7); }
        .ghost span, .limit span { position: absolute; left: 8px; top: -10px; font: 600 11px/18px system-ui, sans-serif; padding: 0 8px; border-radius: 999px; white-space: nowrap; }
        .ghost span { color: #fff; background: rgba(79,91,213,.8); }
        .limit { border-top: 1px solid #dc2626; }
        .limit span { left: auto; right: 8px; color: #b91c1c; background: #fff; border: 1px solid #fca5a5; }
        .bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); pointer-events: auto;
          display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: center;
          max-width: calc(100vw - 24px); box-sizing: border-box;
          background: #1f2430; color: #fff; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
          padding: 8px 10px; border-radius: 12px; box-shadow: 0 10px 28px rgba(0,0,0,.3); }
        .bar b { font-weight: 700; }
        .hint { color: #b8bfd0; font-size: 12px; }
        button, select { font: inherit; border-radius: 8px; border: 1px solid #4a5268; background: #2b3242; color: #fff; padding: 4px 10px; cursor: pointer; }
        button:hover:not(:disabled) { background: #374058; }
        button:disabled { opacity: .45; cursor: default; }
        button.go { background: #4f5bd5; border-color: #4f5bd5; font-weight: 650; }
        button.go:hover { background: #5e69e0; }
      </style>
      <div class="bands"></div>
      <div class="lines"></div>
      <div class="ghost"><span>+ Cut here</span></div>
      <div class="limit"><span>page length</span></div>
      <div class="bar" role="toolbar" aria-label="Page breaks">
        <b class="count"></b>
        <select class="length" aria-label="Page length"></select>
        <span class="hint">Drag a line to move it · click to add · Alt: anywhere</span>
        <button type="button" class="undo" title="Undo (Ctrl+Z)">Undo</button>
        <button type="button" class="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
        <button type="button" class="auto" title="Plan the cuts again">Auto</button>
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="go">Save PDF</button>
      </div>`;
      const $ = (sel) => root.querySelector(sel);
      const bands = $(".bands");
      const lines = $(".lines");
      const ghost = $(".ghost");
      const limit = $(".limit");
      const count = $(".count");
      const lengthSelect = $(".length");
      const LABELS = { screen: "About one screen", a4: "About one A4 page", "2a4": "About two A4 pages", custom: "Custom length" };
      for (const [key, px] of Object.entries(plan.lengths || {})) {
        const opt = document.createElement("option");
        opt.value = String(px);
        opt.textContent = LABELS[key] || key;
        if (px === plan.target) opt.selected = true;
        lengthSelect.append(opt);
      }
      if (!lengthSelect.options.length) lengthSelect.remove();
      document.documentElement.append(host);

      const history = [];
      const future = [];
      let selected = null; // the cut the arrow keys and Delete act on
      let drag = null; // { el, y, from }
      const cutNodes = [];
      const bandNodes = [];

      const change = (breaks) => {
        history.push(plan.breaks.slice());
        if (history.length > 200) history.shift();
        future.length = 0;
        plan.breaks = sorted(breaks);
        paint();
      };

      const node = (pool, i, make) => {
        if (!pool[i]) pool[i] = make();
        return pool[i];
      };
      const makeCut = () => {
        const cut = document.createElement("div");
        cut.className = "cut";
        cut.innerHTML = `<span class="grip"><span class="t"></span><button type="button" class="x" title="Remove this cut" aria-label="Remove this cut">✕</button></span>`;
        cut.querySelector(".x").addEventListener("click", (e) => {
          e.stopPropagation();
          const el = cut.__el;
          if (selected === el) selected = null;
          change(plan.breaks.filter((b) => b !== el));
        });
        cut.querySelector(".x").addEventListener("pointerdown", (e) => e.stopPropagation());
        cut.addEventListener("pointerdown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          cut.setPointerCapture(e.pointerId);
          selected = cut.__el;
          drag = { el: cut.__el, y: yOf(cut.__el), from: cut.__el, pointer: e.pointerId, lastY: e.clientY };
          paint();
          autoScroll();
        });
        cut.addEventListener("pointermove", (e) => {
          if (!drag || e.pointerId !== drag.pointer) return;
          drag.lastY = e.clientY;
          dragTo(e.clientY + scrollY, e.altKey);
        });
        const end = (e) => {
          if (!drag || e.pointerId !== drag.pointer) return;
          const { el, from } = drag;
          drag = null;
          if (el !== from) {
            selected = el;
            change(plan.breaks.map((b) => (b === from ? el : b)));
          } else paint();
        };
        cut.addEventListener("pointerup", end);
        cut.addEventListener("pointercancel", end);
        lines.append(cut);
        return cut;
      };
      const makeBand = () => {
        const band = document.createElement("div");
        band.className = "band";
        band.innerHTML = `<span class="label"></span>`;
        bands.append(band);
        return band;
      };

      function dragTo(y, any) {
        const others = new Set(plan.breaks.filter((b) => b !== drag.from));
        const c = nearest(any ? plan.candidates : plan.clean, y, others);
        if (c && c.el !== drag.el) { drag.el = c.el; drag.y = c.y; paint(); }
      }

      // While a cut is dragged near the top or bottom of the window, scroll.
      function autoScroll() {
        if (!drag) return;
        const edge = 48;
        const dy = drag.lastY < edge ? -18 : drag.lastY > innerHeight - edge ? 18 : 0;
        if (dy) { scrollBy(0, dy); dragTo(drag.lastY + scrollY, false); }
        requestAnimationFrame(autoScroll);
      }

      function paint() {
        // What is shown: the plan, with the dragged cut where it is now.
        const shown = drag ? sorted(plan.breaks.map((b) => (b === drag.from ? drag.el : b))) : plan.breaks;
        const ys = shown.map(yOf);
        const edges = [0, ...ys, plan.height];
        const heights = edges.slice(1).map((y, i) => y - edges[i]);
        let long = 0;
        heights.forEach((h, i) => {
          const band = node(bandNodes, i, makeBand);
          band.style.display = "";
          band.style.top = `${edges[i]}px`;
          band.style.height = `${h}px`;
          const over = h > plan.target * 1.02;
          if (over) long += 1;
          band.className = `band${i % 2 ? " odd" : ""}${over ? " long" : ""}`;
          band.firstChild.textContent = `Page ${i + 1} · ${Math.round((h / plan.target) * 100)}%${over ? " — longer than the page length" : ""}`;
        });
        for (let i = heights.length; i < bandNodes.length; i += 1) bandNodes[i].style.display = "none";
        shown.forEach((el, i) => {
          const cut = node(cutNodes, i, makeCut);
          cut.__el = el;
          cut.style.display = "";
          cut.style.top = `${ys[i]}px`;
          const dragging = drag && el === drag.el;
          cut.className = `cut${dragging ? " drag" : ""}${!drag && el === selected ? " sel" : ""}`;
          cut.querySelector(".t").textContent = `Page ${i + 2}`;
        });
        for (let i = shown.length; i < cutNodes.length; i += 1) cutNodes[i].style.display = "none";
        // The page length, measured from the top of the page being dragged.
        if (drag) {
          const i = shown.indexOf(drag.el);
          limit.style.display = "block";
          limit.style.top = `${edges[i] + plan.target}px`;
        } else limit.style.display = "none";
        count.textContent = `${heights.length} page${heights.length === 1 ? "" : "s"}${long ? ` · ${long} longer than the page length` : ""}`;
        $(".undo").disabled = !history.length;
        $(".redo").disabled = !future.length;
      }

      const finish = (err) => {
        drag = null;
        removeEventListener("click", onClick, true);
        for (const t of ["mousedown", "pointerdown", "mouseup", "pointerup", "touchstart", "dblclick", "contextmenu"]) removeEventListener(t, swallow, true);
        removeEventListener("mousemove", onMove, true);
        removeEventListener("keydown", onKey, true);
        host.remove();
        if (err) reject(err); else resolve(planReport());
      };
      const fromUi = (e) => e.composedPath().includes(host);
      const swallow = (e) => { if (!fromUi(e)) { e.preventDefault(); e.stopPropagation(); } };
      const addAt = (y, any) => nearest(any ? plan.candidates : plan.clean, y, new Set(plan.breaks));
      const onMove = (e) => {
        if (drag || fromUi(e)) { ghost.style.display = "none"; return; }
        const c = addAt(e.clientY + scrollY, e.altKey);
        if (!c) { ghost.style.display = "none"; return; }
        ghost.style.display = "block";
        ghost.style.top = `${c.y}px`;
      };
      const onClick = (e) => {
        if (fromUi(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const c = addAt(e.clientY + scrollY, e.altKey);
        if (!c) return;
        selected = c.el;
        ghost.style.display = "none";
        change([...plan.breaks, c.el]);
      };
      const undoStep = () => {
        if (!history.length) return;
        future.push(plan.breaks.slice());
        plan.breaks = history.pop();
        if (!plan.breaks.includes(selected)) selected = null;
        paint();
      };
      const redoStep = () => {
        if (!future.length) return;
        history.push(plan.breaks.slice());
        plan.breaks = future.pop();
        paint();
      };
      const onKey = (e) => {
        const inSelect = e.composedPath()[0] === lengthSelect;
        const k = e.key;
        const mod = e.ctrlKey || e.metaKey;
        let handled = true;
        if (k === "Escape") finish(new Error("cancelled"));
        else if (k === "Enter" && !inSelect) finish();
        else if (mod && (k === "z" || k === "Z") && !e.shiftKey) undoStep();
        else if (mod && (((k === "z" || k === "Z") && e.shiftKey) || k === "y" || k === "Y")) redoStep();
        else if ((k === "Delete" || k === "Backspace") && selected && plan.breaks.includes(selected)) {
          const el = selected;
          selected = null;
          change(plan.breaks.filter((b) => b !== el));
        } else if ((k === "ArrowUp" || k === "ArrowDown") && selected && plan.breaks.includes(selected) && !inSelect) {
          const c = stepFrom(e.altKey ? plan.candidates : plan.clean, yOf(selected), k === "ArrowUp" ? -1 : 1, new Set(plan.breaks));
          if (c) {
            const from = selected;
            selected = c.el;
            change(plan.breaks.map((b) => (b === from ? c.el : b)));
            const y = c.y - scrollY;
            if (y < 60 || y > innerHeight - 100) scrollTo(0, c.y - innerHeight / 2);
          }
        } else handled = false;
        if (handled) { e.preventDefault(); e.stopPropagation(); }
      };
      $(".go").addEventListener("click", () => finish());
      $(".cancel").addEventListener("click", () => finish(new Error("cancelled")));
      $(".undo").addEventListener("click", undoStep);
      $(".redo").addEventListener("click", redoStep);
      $(".auto").addEventListener("click", () => {
        selected = null;
        const { breaks, uncut } = chooseBreaks(plan.clean, plan.height, plan.target);
        plan.uncut = uncut;
        change(breaks);
      });
      lengthSelect.addEventListener("change", () => {
        const target = Number(lengthSelect.value);
        const { breaks, uncut } = chooseBreaks(plan.clean, plan.height, target);
        Object.assign(plan, { uncut, target });
        selected = null;
        change(breaks);
      });
      addEventListener("click", onClick, true);
      for (const t of ["mousedown", "pointerdown", "mouseup", "pointerup", "touchstart", "dblclick", "contextmenu"]) addEventListener(t, swallow, true);
      addEventListener("mousemove", onMove, true);
      addEventListener("keydown", onKey, true);
      plan.breaks = sorted(plan.breaks);
      paint();
      // Start where the first cut is, so the reader sees what this is about.
      if (plan.breaks.length) scrollTo(0, Math.max(0, yOf(plan.breaks[0]) - innerHeight * 0.6));
    });
  }

  /**
   * Turns the planned cuts into page breaks, and marks where each page's
   * content ends (markPageEnd). Returns each page's content height, and which
   * pages have a marker.
   */
  function applyBreaks() {
    if (!plan) {
      const marked = markPageEnd(0, null);
      return { pages: 1, heights: [measure().height], uncut: false, markers: [marked] };
    }
    const breaks = sorted(plan.breaks);
    plan.markers = [...breaks, null].map((next, i) => markPageEnd(i, next));
    breaks.forEach((el) => {
      setStyle(el, "break-before", "page");
      setStyle(el, "page-break-before", "always");
      // Chrome keeps a block's top margin after a forced break: white space
      // at the top of the page, and room the measured height did not count.
      setStyle(el, "margin-top", "0");
    });
    plan.breaks = breaks;
    plan.byEl = null; // positions from here on are read afresh
    plan.height = measure().height;
    const report = planReport();
    // A table cut between its rows prints its header row again at the top of
    // the next page: room the measured height of that page has to include.
    breaks.forEach((el, i) => {
      if (el.tagName !== "TR") return;
      const head = el.closest("table") && el.closest("table").tHead;
      const s = head && style(head);
      if (s && s.display === "table-header-group") report.heights[i + 1] += Math.ceil(head.getBoundingClientRect().height);
    });
    scrollTo(0, 0);
    return report;
  }

  function sorted(breaks) {
    return breaks.slice().sort((a, b) => yOf(a) - yOf(b));
  }

  // ---------------------------------------------------------------- entry points

  async function prepare(o) {
    journal = [];
    startScroll = [scrollX, scrollY];
    const facts = core ? core.pageFacts() : { title: document.title, url: location.href, site: location.hostname };
    const report = { facts, cleaned: 0, images: [], resized: 0, fonts: 0, headings: [] };

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

    if (!o.effects) stripEffects(o);
    if (o.fonts === "standard") report.fonts = replaceFonts([], true);

    await waitForImages(3000);
    report.images = collectImages(o);
    report.headings = o.outline && !o.tagged ? markHeadings() : [];
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
    linkBox = null;
    // After the journal: the pictures' own sources are back by now.
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls = [];
    scrollTo(startScroll[0], startScroll[1]);
    return true;
  }

  globalThis.__recallPdf = {
    prepare, measure, restore, pickElement, swapImages, replaceFonts, planBreaks, editBreaks, applyBreaks,
    facts: () => core && core.pageFacts()
  };
})();
