// Recall Web to PDF — page preparation.
//
// Evaluated by background.js through the DevTools protocol, in an isolated
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
    const before = el.style.getPropertyValue(prop);
    const prio = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value, "important");
    undo(() => { if (before) el.style.setProperty(prop, before, prio); else el.style.removeProperty(prop); });
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
    scrollTo(startScroll[0], startScroll[1]);
    return true;
  }

  globalThis.__recallPdf = { prepare, measure, restore, pickElement, swapImages, facts: () => core && core.pageFacts() };
})();
