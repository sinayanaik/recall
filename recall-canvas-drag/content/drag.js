// Recall Drag to Canvas — the part that runs in every page.
//
// A web page lets you drag a selection, a link or a picture, and nothing else:
// a box, a card, a code listing, a table or a figure cannot be picked up at all,
// and what a selection carries is whatever the browser makes of it. This puts a
// ⠿ grip on any part of any page, and dragging the grip onto a Recall Canvas
// carries that part whole:
//
//   • Hold Alt and point at the page: the part under the pointer is outlined,
//     with its ⠿ grip above its top-left corner. Alt+↑ / Alt+↓ (or Alt and the
//     wheel) widen the outline to the part around it, or narrow it back.
//     Letting go of Alt keeps the outline while the pointer stays on it, so the
//     grip can be dragged without holding anything.
//   • Alt+Shift+D (or the popup) shows the grips without holding Alt, on this
//     tab, until pressed again.
//   • Drag the grip onto a Canvas page. It lands as Blocks: headings, lists,
//     tables, code, maths and pictures kept. Hold Shift as you let go and it
//     lands as a picture of the part exactly as the page shows it.
//
// What the drag carries is prepared as soon as the outline settles, because a
// drag's data has to be handed over the moment it starts and cannot wait:
//
//   • the part's HTML, cleaned — hidden things, scripts and styles out, links
//     and picture addresses made whole, a picture's best source chosen (the one
//     the page actually shows), a drawn <canvas> and a large inline <svg> turned
//     into pictures, form fields into their values;
//   • its pictures' bytes, fetched by the background worker (which a site's
//     CORS rules do not stop), so Recall can keep its own copy;
//   • a picture of the part as it is on screen (the visible part of it), for a
//     drop with Shift held.
//
// All of it travels as one JSON value under application/x-recall-web-clip, which
// Recall reads (src/documents/canvas-drop.js); text/html and text/plain go
// beside it, so the same drag also works anywhere else.
//
// Nothing runs on Recall itself (its own grips do the same there), and nothing
// is uploaded anywhere: the drag is the only way anything leaves the page.
(() => {
  "use strict";

  if (window.__recallCanvasDrag) return;
  window.__recallCanvasDrag = true;
  if (!(document.documentElement instanceof HTMLElement)) return; // an XML or SVG document
  if (document.querySelector('meta[name="application-name"][content="Recall"]')) return;

  const MIME = "application/x-recall-web-clip";
  const SETTLE_MS = 250;
  const MAX_IMAGES = 12;
  const MAX_IMAGE_TOTAL = 8 * 1024 * 1024;
  const MAX_NODES = 6000;
  const MAX_TEXT = 200000;
  const CAPTURE_GAP_MS = 600;
  const ICON_SIZE = 28;
  const HIDE_ATTR = "data-rdc-hide";
  const SRC_ATTR = "data-rdc-src";
  const CANVAS_ATTR = "data-rdc-canvas";
  const VALUE_ATTR = "data-rdc-value";
  const SIZE_ATTR = "data-rdc-size";

  // ── Settings ──────────────────────────────────────────────────────────────

  let enabled = true;      // the popup's On
  let siteOff = false;     // the popup's "Not on this site"
  let gripsOn = false;     // Alt+Shift+D: grips without holding Alt, this tab

  function applySettings(values) {
    enabled = values.enabled !== false;
    const off = Array.isArray(values.offSites) ? values.offSites : [];
    siteOff = off.includes(location.hostname);
    if (!enabled || siteOff) clearPick();
  }

  try {
    chrome.storage.sync.get({ enabled: true, offSites: [] }).then(applySettings, () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      chrome.storage.sync.get({ enabled: true, offSites: [] }).then(applySettings, () => {});
    });
  } catch (_) { /* the extension was reloaded under this page */ }

  function active() {
    return enabled && !siteOff;
  }

  // ── The overlay ───────────────────────────────────────────────────────────
  //
  // One element on the page, in the top layer (a manual popover) so no page's
  // stacking, overflow or transform can cover it, with a closed shadow root so
  // no page's CSS reaches inside. It takes no pointer events but the grip's.

  //
  // A site with a strict Content-Security-Policy refuses inline style
  // attributes and <style> elements, even ones a content script adds, so the
  // host is styled through the CSSOM and the shadow root by a constructed
  // stylesheet, neither of which CSP governs.
  const host = document.createElement("recall-canvas-drag");
  const HOST_STYLE = {
    position: "fixed", inset: "0", width: "100vw", height: "100vh", "max-width": "none", "max-height": "none",
    margin: "0", padding: "0", border: "0", background: "transparent", overflow: "visible",
    "pointer-events": "none", display: "block", "z-index": "2147483647", "color-scheme": "light"
  };
  for (const [name, value] of Object.entries(HOST_STYLE)) host.style.setProperty(name, value, "important");
  if ("popover" in HTMLElement.prototype) host.setAttribute("popover", "manual");
  const root = host.attachShadow({ mode: "closed" });
  const SHEET = `
  :host { all: initial; }
  .wrap { position: fixed; inset: 0; pointer-events: none; font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap[hidden] { display: none; }
  .box {
    position: fixed; box-sizing: border-box; border: 2px solid #14a99e; border-radius: 4px;
    background: rgba(26, 196, 184, 0.08); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.7);
    pointer-events: none;
  }
  .grip {
    position: fixed; display: inline-flex; align-items: center; gap: 6px; height: 24px;
    padding: 0 9px 0 7px; box-sizing: border-box; border-radius: 6px 6px 6px 0;
    background: #14a99e; color: #fff; cursor: grab; pointer-events: auto; user-select: none;
    -webkit-user-select: none; white-space: nowrap; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    touch-action: none;
  }
  .grip:active { cursor: grabbing; }
  .grip .dots { font-size: 15px; line-height: 1; }
  .grip .state { opacity: 0.85; font-weight: 400; }
  .grip .keys { opacity: 0.75; font-weight: 400; font-size: 11px; }
  .thumb {
    position: fixed; left: -10000px; top: 0; max-width: 220px; padding: 6px; box-sizing: border-box;
    background: #fff; color: #1d2433; border: 2px solid #14a99e; border-radius: 8px;
    font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .thumb img { display: block; max-width: 204px; max-height: 150px; border-radius: 4px; }
  .thumb .words { display: block; max-width: 204px; max-height: 60px; overflow: hidden; }
`;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHEET);
    root.adoptedStyleSheets = [sheet];
  } catch (_) {
    // No constructed stylesheets: a <style>, which a strict CSP may refuse.
    const style = document.createElement("style");
    style.textContent = SHEET;
    root.appendChild(style);
  }
  // Built node by node rather than from markup: a page that enforces Trusted
  // Types refuses an HTML string.
  const make = (tag, className, attrs = {}, kids = []) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    node.append(...kids);
    return node;
  };
  root.append(
    make("div", "wrap", { hidden: "" }, [
      make("div", "box"),
      make("div", "grip", { draggable: "true", title: "Drag onto a Recall Canvas. Hold Shift as you let go for a picture of it." }, [
        make("span", "dots", { "aria-hidden": "true" }, ["⠿"]),
        make("span", "kind"),
        make("span", "state"),
        make("span", "keys", {}, ["Alt+↑↓"])
      ])
    ]),
    make("div", "thumb", {}, [make("img", "", { alt: "" }), make("span", "words")])
  );
  const wrap = root.querySelector(".wrap");
  const box = root.querySelector(".box");
  const grip = root.querySelector(".grip");
  const kindLabel = root.querySelector(".kind");
  const stateLabel = root.querySelector(".state");
  const thumb = root.querySelector(".thumb");
  const thumbImg = thumb.querySelector("img");
  const thumbWords = thumb.querySelector(".words");

  function mountHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    // Again each time it shows: a page's own popover or dialog opened since
    // would be above it otherwise.
    try {
      if (host.matches(":popover-open")) host.hidePopover();
      host.showPopover?.();
    } catch (_) { /* no popover support: plain fixed position */ }
  }

  function unmountHost() {
    try { if (host.matches(":popover-open")) host.hidePopover(); } catch (_) { /* never shown */ }
    host.remove();
  }

  // ── What is picked ────────────────────────────────────────────────────────

  // { path: [deepest … outermost], level, el }
  let pick = null;
  let altHeld = false;
  let latched = false;
  let dragging = false;
  let pointer = { x: -1, y: -1 };
  let rafId = 0;

  const ATOMS = "pre, table, figure, picture, img, svg, canvas, video, math, blockquote, h1, h2, h3, h4, h5, h6";

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const rootNode = el.getRootNode?.();
    return rootNode && rootNode.host ? rootNode.host : null;
  }

  function isOurs(node) {
    return node === host;
  }

  // From the deepest node under the pointer up to (not including) <body>.
  function ancestry(node) {
    const out = [];
    let el = node && node.nodeType === 1 ? node : node?.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      out.push(el);
      el = parentOf(el);
    }
    return out;
  }

  function isInlineish(el) {
    const display = getComputedStyle(el).display;
    return display === "inline" || display === "contents" || display === "none";
  }

  // The first sensible part for a pointer over `path[0]`: the nearest whole
  // thing (a table, a listing, a figure, a picture, a heading) it is in, else
  // the nearest block that has some size.
  function defaultLevel(path) {
    // An <svg>'s own shapes are not parts: the outermost <svg> is.
    let start = 0;
    for (let i = 0; i < path.length; i += 1) {
      if (path[i] instanceof SVGElement && !(path[i] instanceof SVGSVGElement && !(parentOf(path[i]) instanceof SVGElement))) start = i + 1;
      else break;
    }
    if (path[start - 1] instanceof SVGSVGElement) start -= 1;
    for (let i = start; i < path.length; i += 1) {
      const el = path[i];
      if (!el.matches?.(ATOMS)) continue;
      // A picture inside a figure, a table's cell inside its table: the outer one.
      const figure = el.closest?.("figure");
      if (figure && path.includes(figure) && el.matches("img, picture, svg, canvas, video")) return path.indexOf(figure);
      return i;
    }
    for (let i = start; i < path.length; i += 1) {
      const el = path[i];
      if (isInlineish(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width >= 24 && rect.height >= 14) return i;
    }
    return Math.min(start, path.length - 1);
  }

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "table") return "Table";
    if (tag === "pre" || tag === "code") return "Code";
    if (/^h[1-6]$/.test(tag)) return "Heading";
    if (["img", "picture", "figure", "svg", "canvas", "video"].includes(tag)) return "Picture";
    if (tag === "ul" || tag === "ol" || tag === "dl") return "List";
    if (tag === "li") return "List item";
    if (tag === "p") return "Paragraph";
    if (tag === "blockquote") return "Quote";
    if (tag === "math") return "Maths";
    return "Part of the page";
  }

  function setPick(path, level, { manual = false } = {}) {
    if (!path.length) { clearPick(); return; }
    const clamped = Math.max(0, Math.min(path.length - 1, level));
    const el = path[clamped];
    const changed = !pick || pick.el !== el;
    pick = { path, level: clamped, el, manual };
    if (changed) {
      prepared = null;
      kindLabel.textContent = kindOf(el);
      stateLabel.textContent = "";
      schedulePrepare();
    }
    mountHost();
    wrap.hidden = false;
    place();
    if (!rafId) rafId = requestAnimationFrame(follow);
  }

  function clearPick() {
    pick = null;
    latched = false;
    prepared = null;
    clearTimeout(prepareTimer);
    preparing = null;
    wrap.hidden = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (!dragging) unmountHost();
  }

  function gripRect() {
    return grip.getBoundingClientRect();
  }

  function place() {
    if (!pick) return;
    if (!pick.el.isConnected) { clearPick(); return; }
    const r = pick.el.getBoundingClientRect();
    box.style.left = `${Math.round(r.left - 3)}px`;
    box.style.top = `${Math.round(r.top - 3)}px`;
    box.style.width = `${Math.round(r.width + 6)}px`;
    box.style.height = `${Math.round(r.height + 6)}px`;
    // Above the part's top-left corner, touching it, so the pointer goes
    // straight up into it without crossing anything else; inside it when the
    // part starts at the top of the window.
    const h = 24;
    const top = r.top - 3 - h >= 0 ? r.top - 3 - h : Math.max(0, r.top + 2);
    const left = Math.max(2, Math.min(window.innerWidth - 160, r.left - 3));
    grip.style.top = `${Math.round(top)}px`;
    grip.style.left = `${Math.round(left)}px`;
  }

  function follow() {
    rafId = 0;
    if (!pick) return;
    place();
    rafId = requestAnimationFrame(follow);
  }

  function armed() {
    return active() && (altHeld || gripsOn);
  }

  function within(rect, x, y, pad = 0) {
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
  }

  // The pointer moved over the page (not over the grip).
  function onPointerMove(event) {
    if (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    pointer = { x: event.clientX, y: event.clientY };
    if (dragging) return;
    const target = event.composedPath?.()[0] || event.target;
    if (isOurs(target)) return;
    if (pick && within(gripRect(), event.clientX, event.clientY, 8)) return;
    if (!armed()) {
      // Alt let go of: the outline stays while the pointer is on it.
      if (pick && latched && within(pick.el.getBoundingClientRect(), event.clientX, event.clientY, 24)) return;
      if (pick) clearPick();
      return;
    }
    const path = ancestry(target);
    if (!path.length) { clearPick(); return; }
    // Still inside what is picked, at a level chosen by hand: keep it.
    if (pick && pick.manual && path.includes(pick.el)) return;
    if (pick && path[0] === pick.path[0]) return;
    setPick(path, defaultLevel(path));
  }

  function pickAtPointer() {
    if (pointer.x < 0) return;
    const target = deepestAt(pointer.x, pointer.y);
    if (!target || isOurs(target)) return;
    const path = ancestry(target);
    if (path.length) setPick(path, defaultLevel(path));
  }

  // elementFromPoint stops at a shadow root's host; this goes on into open ones.
  function deepestAt(x, y) {
    let el = document.elementFromPoint(x, y);
    for (let i = 0; i < 20 && el?.shadowRoot; i += 1) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function widen(by) {
    if (!pick) return;
    // Wider is further out; a pick at the outermost is kept at <body>'s child.
    setPick(pick.path, pick.level + by, { manual: true });
  }

  function onKeyDown(event) {
    if (event.key === "Alt") {
      if (!altHeld) {
        altHeld = true;
        latched = false;
        if (active() && !dragging) pickAtPointer();
      }
      return;
    }
    if (!pick || !event.altKey) {
      if (event.key === "Escape" && pick && !dragging) clearPick();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      widen(event.key === "ArrowUp" ? 1 : -1);
    }
  }

  function onKeyUp(event) {
    if (event.key !== "Alt") return;
    altHeld = false;
    // Alt+Shift+D's grips stay; otherwise the outline is kept while the
    // pointer is on it, so its grip can be dragged.
    if (pick && !gripsOn) latched = true;
  }

  function onWheel(event) {
    if (!pick || !event.altKey || !armed() || dragging) return;
    event.preventDefault();
    event.stopPropagation();
    widen(event.deltaY < 0 ? 1 : -1);
  }

  window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  // A press anywhere but the grip: no drag of ours is under way, whatever a
  // dragend that never came would have said.
  window.addEventListener("pointerdown", (event) => {
    if (!isOurs(event.composedPath?.()[0] || event.target)) dragging = false;
  }, { capture: true, passive: true });
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  window.addEventListener("blur", () => {
    altHeld = false;
    if (pick && !dragging && !gripsOn) latched = true;
  });

  // ── Preparing what the drag carries ───────────────────────────────────────

  // { el, kind, html, text, imageUrls, images: { url: dataUrl }, picture, ready }
  let prepared = null;
  let preparing = null;
  let prepareTimer = 0;

  function schedulePrepare() {
    clearTimeout(prepareTimer);
    prepareTimer = setTimeout(() => { if (pick) prepare(pick.el); }, SETTLE_MS);
  }

  function childrenOf(node) {
    const kids = Array.from(node.children || []);
    if (node.shadowRoot) kids.unshift(...Array.from(node.shadowRoot.children));
    return kids;
  }

  // An element's clone with its open shadow roots spliced in where they are
  // shown, so a part built from web components is not an empty tag.
  function deepClone(el) {
    const clone = el.cloneNode(false);
    const sources = el.shadowRoot ? [el.shadowRoot] : [el];
    // A shadow root with a <slot> shows the light children through it.
    for (const source of sources) {
      for (const child of Array.from(source.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName === "SLOT") {
            const assigned = child.assignedNodes?.({ flatten: true }) || [];
            for (const node of assigned) clone.appendChild(node.nodeType === Node.ELEMENT_NODE ? deepClone(node) : node.cloneNode(true));
          } else if (child.tagName !== "STYLE") {
            clone.appendChild(deepClone(child));
          }
        } else {
          clone.appendChild(child.cloneNode(true));
        }
      }
    }
    return clone;
  }

  function absoluteUrl(url) {
    if (!url || /^(?:data|blob):/i.test(url)) return url;
    try { return new URL(url, document.baseURI).href; } catch (_) { return url; }
  }

  // Lazy-loading sites park a placeholder in src and keep the real address
  // elsewhere (ported from recall-clipper/content/picker.js's bestImageUrl).
  function isPlaceholderSrc(url) {
    if (!url) return true;
    if (!/^data:/i.test(url)) return false;
    return url.length < 2048;
  }

  function widestFromSrcset(srcset) {
    const candidates = String(srcset || "").split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const [url, descriptor = ""] = part.split(/\s+/);
      const width = /^(\d+)w$/.exec(descriptor);
      const density = /^([\d.]+)x$/.exec(descriptor);
      return { url, weight: width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 1 };
    }).filter((c) => c.url);
    if (!candidates.length) return "";
    return candidates.reduce((best, c) => (c.weight > best.weight ? c : best)).url;
  }

  const LAZY_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-actualsrc", "data-hi-res-src", "data-full-src"];

  function bestImageUrl(img) {
    const shown = img.getAttribute(SRC_ATTR);
    if (shown && !isPlaceholderSrc(shown)) return shown;
    const src = img.getAttribute("src") || "";
    if (!isPlaceholderSrc(src)) return src;
    for (const attr of LAZY_ATTRS) {
      const value = img.getAttribute(attr);
      if (value && !isPlaceholderSrc(value)) return value;
    }
    const fromSrcset = widestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset"));
    if (fromSrcset && !isPlaceholderSrc(fromSrcset)) return fromSrcset;
    const picture = img.closest && img.closest("picture");
    if (picture) {
      for (const source of Array.from(picture.querySelectorAll("source"))) {
        const candidate = widestFromSrcset(source.getAttribute("srcset") || source.getAttribute("data-srcset"));
        if (candidate && !isPlaceholderSrc(candidate)) return candidate;
      }
    }
    return src;
  }

  function hiddenByStyle(el) {
    const style = getComputedStyle(el);
    if (style.display === "none") return true;
    if (style.visibility === "hidden" || style.visibility === "collapse") return !el.querySelector("*");
    return false;
  }

  // Marks on the live part read by the clone (what is hidden, what a picture
  // actually shows, a field's value, a canvas's index), taken off again before
  // this returns: the page is never left changed.
  function stampLive(el) {
    const stamped = [];
    const canvases = [];
    const stamp = (node, name, value) => { node.setAttribute(name, value); stamped.push([node, name]); };
    let count = 0;
    const visit = (node) => {
      if (count > MAX_NODES) return;
      count += 1;
      const tag = node.tagName;
      if (node !== el && hiddenByStyle(node)) {
        // Maths keeps its source in hidden markup (Wikipedia's MathML, a
        // formula's annotation): that is kept for Recall to read.
        if (!node.querySelector("math, annotation")) { stamp(node, HIDE_ATTR, ""); return; }
      }
      if (tag === "IMG") {
        const shown = node.currentSrc || "";
        if (shown && !isPlaceholderSrc(shown)) stamp(node, SRC_ATTR, shown);
        const r = node.getBoundingClientRect();
        if (r.width && r.height) stamp(node, SIZE_ATTR, `${Math.round(r.width)}x${Math.round(r.height)}`);
      } else if (tag === "CANVAS") {
        stamp(node, CANVAS_ATTR, String(canvases.length));
        canvases.push(node);
      } else if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        let value = "";
        if (tag === "SELECT") value = Array.from(node.selectedOptions || []).map((o) => o.textContent.trim()).join(", ");
        else if (node.type === "checkbox" || node.type === "radio") value = node.checked ? "☑" : "☐";
        else if (node.type !== "password" && node.type !== "hidden") value = node.value || node.placeholder || "";
        stamp(node, VALUE_ATTR, value);
      } else if (node instanceof SVGSVGElement) {
        const r = node.getBoundingClientRect();
        stamp(node, SIZE_ATTR, `${Math.round(r.width)}x${Math.round(r.height)}`);
        return; // its insides go as they are
      }
      for (const child of childrenOf(node)) visit(child);
    };
    visit(el);
    return {
      canvases,
      undo() { for (const [node, name] of stamped) node.removeAttribute(name); }
    };
  }

  function sizeOf(node) {
    const [w, h] = String(node.getAttribute(SIZE_ATTR) || "").split("x").map(Number);
    return { w: w || 0, h: h || 0 };
  }

  // `picked`: the <svg> is the part picked itself, so it is wanted however small.
  function svgToImg(svg, doc, picked = false) {
    const { w, h } = sizeOf(svg);
    if (!picked && w < ICON_SIZE && h < ICON_SIZE) return null; // an icon
    svg.removeAttribute(SIZE_ATTR);
    if (!svg.getAttribute("xmlns")) svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (w && !svg.getAttribute("width")) svg.setAttribute("width", String(w));
    if (h && !svg.getAttribute("height")) svg.setAttribute("height", String(h));
    let markup;
    try { markup = new XMLSerializer().serializeToString(svg); } catch (_) { return null; }
    const img = doc.createElement("img");
    img.setAttribute("src", `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(markup)))}`);
    img.setAttribute("alt", svg.getAttribute("aria-label") || svg.querySelector("title")?.textContent?.trim() || "");
    return img;
  }

  function textOf(node) {
    return String(node.textContent || "").replace(/\s+/g, " ").trim();
  }

  // The part's HTML as Recall should read it, and its words.
  function snapshot(el) {
    const marks = stampLive(el);
    let clone;
    let canvasData;
    try {
      clone = deepClone(el);
      // Only the live canvases have pixels.
      canvasData = marks.canvases.map((canvas) => {
        try { return canvas.toDataURL("image/png"); } catch (_) { return ""; } // drawn from another site
      });
    } finally {
      marks.undo();
    }
    const doc = document.implementation.createHTMLDocument("");
    const holder = doc.createElement("div");
    holder.appendChild(doc.importNode(clone, true));

    holder.querySelectorAll(`[${HIDE_ATTR}]`).forEach((node) => node.remove());
    holder.querySelectorAll("script, style, noscript, template, link, meta, object, embed, param, source, track, dialog:not([open])").forEach((node) => node.remove());
    holder.querySelectorAll(`[${CANVAS_ATTR}]`).forEach((node) => {
      const data = canvasData[Number(node.getAttribute(CANVAS_ATTR))];
      if (!data || data.length < 200) { node.remove(); return; }
      const img = doc.createElement("img");
      img.setAttribute("src", data);
      node.replaceWith(img);
    });
    holder.querySelectorAll("svg").forEach((svg) => {
      if (svg.parentElement?.closest("svg")) return;
      const img = svgToImg(svg, doc, svg === holder.firstElementChild);
      if (img) svg.replaceWith(img);
      else svg.remove();
    });
    holder.querySelectorAll(`[${VALUE_ATTR}]`).forEach((node) => {
      const value = node.getAttribute(VALUE_ATTR);
      if (!value) { node.remove(); return; }
      const span = doc.createElement(node.tagName === "TEXTAREA" ? "p" : "span");
      span.textContent = value;
      node.replaceWith(span);
    });
    // A button is its words.
    holder.querySelectorAll("button").forEach((button) => {
      const words = textOf(button);
      if (!words) { button.remove(); return; }
      const span = doc.createElement("span");
      span.textContent = words;
      button.replaceWith(span);
    });
    holder.querySelectorAll("iframe").forEach((frame) => {
      const src = absoluteUrl(frame.getAttribute("src") || "");
      if (!/^https?:/i.test(src)) { frame.remove(); return; }
      const a = doc.createElement("a");
      a.setAttribute("href", src);
      a.textContent = frame.getAttribute("title") || src;
      const p = doc.createElement("p");
      p.appendChild(a);
      frame.replaceWith(p);
    });
    holder.querySelectorAll("video").forEach((video) => {
      const poster = absoluteUrl(video.getAttribute("poster") || "");
      const src = absoluteUrl(video.getAttribute("src") || video.querySelector("source")?.getAttribute("src") || "");
      const p = doc.createElement("p");
      if (poster) {
        const img = doc.createElement("img");
        img.setAttribute("src", poster);
        img.setAttribute("alt", "Video");
        if (/^https?:/i.test(src)) {
          const a = doc.createElement("a");
          a.setAttribute("href", src);
          a.appendChild(img);
          p.appendChild(a);
        } else {
          p.appendChild(img);
        }
      } else if (/^https?:/i.test(src)) {
        const a = doc.createElement("a");
        a.setAttribute("href", src);
        a.textContent = "Video";
        p.appendChild(a);
      }
      if (p.firstChild) video.replaceWith(p); else video.remove();
    });
    holder.querySelectorAll("img").forEach((img) => {
      const url = absoluteUrl(bestImageUrl(img));
      const { w, h } = sizeOf(img);
      if (!url || (w && h && w <= 2 && h <= 2)) { img.remove(); return; } // a tracking pixel
      img.setAttribute("src", url);
      for (const name of ["srcset", "sizes", "loading", "decoding", "fetchpriority", SRC_ATTR, SIZE_ATTR, ...LAZY_ATTRS]) img.removeAttribute(name);
    });
    holder.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (/^\s*javascript:/i.test(href)) { a.removeAttribute("href"); return; }
      if (!href.startsWith("#")) a.setAttribute("href", absoluteUrl(href));
    });
    // What only the page itself used.
    holder.querySelectorAll("*").forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name;
        if (name === "style" || name.startsWith("on") || name === "contenteditable" || name === "draggable" || name === "tabindex"
          || name.startsWith("data-rdc-") || (name.startsWith("data-") && !/^data-(?:lang|language|math|latex|tex|formula)$/.test(name))) {
          node.removeAttribute(name);
        }
      }
    });

    const html = holder.innerHTML.trim();
    let text = "";
    try { text = String(el.innerText || "").trim(); } catch (_) { text = textOf(el); }
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
    const imageUrls = [...new Set(Array.from(holder.querySelectorAll("img"))
      .map((img) => img.getAttribute("src") || "")
      .filter((src) => /^https?:/i.test(src)))];
    return { el, kind: kindOf(el), html, text, imageUrls, images: {}, picture: null, ready: false };
  }

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (_) {
      return Promise.resolve(null); // the extension was reloaded under this page
    }
  }

  async function fetchImages(urls, isCurrent) {
    const images = {};
    let total = 0;
    const list = urls.slice(0, MAX_IMAGES);
    let next = 0;
    const worker = async () => {
      while (next < list.length && isCurrent() && total < MAX_IMAGE_TOTAL) {
        const url = list[next];
        next += 1;
        const result = await send({ type: "rdc-fetch-image", url });
        if (result && result.ok && total + result.bytes <= MAX_IMAGE_TOTAL) {
          images[url] = result.dataUrl;
          total += result.bytes;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return images;
  }

  let lastCaptureAt = 0;

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  // A picture of the part as it is on screen: the outline is hidden for the
  // moment it takes.
  async function capturePicture(el, isCurrent) {
    const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (!isCurrent() || dragging) return null;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right);
    const bottom = Math.min(window.innerHeight, r.bottom);
    if (right - x < 4 || bottom - y < 4) return null;
    wrap.hidden = true;
    await nextFrame();
    await nextFrame();
    lastCaptureAt = Date.now();
    const result = await send({ type: "rdc-capture", rect: { x, y, width: right - x, height: bottom - y }, dpr: window.devicePixelRatio || 1 });
    if (pick) wrap.hidden = false;
    if (!result || !result.ok) return null;
    return {
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      cssWidth: Math.round(right - x),
      cssHeight: Math.round(bottom - y),
      cut: r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight
    };
  }

  async function prepare(el) {
    const token = {};
    preparing = token;
    const isCurrent = () => preparing === token && pick?.el === el;
    let made;
    try {
      made = snapshot(el);
    } catch (error) {
      console.warn("Recall Drag to Canvas: could not read this part —", error);
      return;
    }
    if (!isCurrent()) return;
    prepared = made;
    stateLabel.textContent = made.imageUrls.length ? "· getting its pictures…" : "";
    setThumb(made);
    const [images, picture] = await Promise.all([
      fetchImages(made.imageUrls, isCurrent),
      capturePicture(el, isCurrent)
    ]);
    if (!isCurrent()) return;
    made.images = images;
    made.picture = picture;
    made.ready = true;
    stateLabel.textContent = "";
    setThumb(made);
  }

  // What the drag shows under the pointer.
  function setThumb(made) {
    if (made.picture?.dataUrl) {
      thumbImg.src = made.picture.dataUrl;
      thumbImg.style.display = "";
      thumbWords.textContent = "";
    } else {
      thumbImg.removeAttribute("src");
      thumbImg.style.display = "none";
      thumbWords.textContent = made.text.slice(0, 160) || made.kind;
    }
  }

  // Re-take the picture once a scroll settles, if it was cut off before.
  let scrollTimer = 0;
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!pick || dragging || !prepared?.ready || !prepared.picture?.cut) return;
      const el = pick.el;
      const token = {};
      preparing = token;
      capturePicture(el, () => preparing === token && pick?.el === el).then((picture) => {
        if (picture && prepared?.el === el) { prepared.picture = picture; setThumb(prepared); }
      });
    }, 300);
  }, { capture: true, passive: true });

  // ── The drag ──────────────────────────────────────────────────────────────

  grip.addEventListener("dragstart", (event) => {
    if (!pick || !event.dataTransfer) { event.preventDefault(); return; }
    let made = prepared && prepared.el === pick.el ? prepared : null;
    if (!made) {
      try { made = snapshot(pick.el); } catch (_) { event.preventDefault(); return; }
      prepared = made;
    }
    const clip = {
      v: 1,
      kind: made.kind,
      html: made.html,
      text: made.text,
      title: document.title || "",
      url: location.href,
      images: made.images || {},
      picture: made.picture || null
    };
    const dt = event.dataTransfer;
    dt.setData(MIME, JSON.stringify(clip));
    dt.setData("text/html", made.html);
    dt.setData("text/plain", made.text || "");
    // Shift held over a drop asks for a move on some systems: allowed here, and
    // Recall answers with a copy.
    dt.effectAllowed = "copyMove";
    try { dt.setDragImage(thumb, 12, 12); } catch (_) { /* the browser's own */ }
    dragging = true;
    preparing = null; // nothing more is waited for
    clearTimeout(prepareTimer);
  });

  grip.addEventListener("dragend", () => {
    dragging = false;
    if (!altHeld && !gripsOn) clearPick();
  });

  // Leaving the grip for the part it stands for keeps it; leaving both, with
  // Alt let go of, takes the outline away (handled by the page's pointermove).
  // A page's own press handlers (a drag library, a "no text selection" guard)
  // can call preventDefault on the press, which cancels a drag before it
  // starts: the grip's press stops here.
  grip.addEventListener("pointerdown", (event) => event.stopPropagation());
  grip.addEventListener("mousedown", (event) => event.stopPropagation());

  // ── Messages from the popup and the shortcut ──────────────────────────────

  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === "rdc-toggle-grips" || msg.type === "rdc-set-grips") {
        gripsOn = msg.type === "rdc-set-grips" ? Boolean(msg.on) : !gripsOn;
        if (gripsOn && active()) pickAtPointer();
        if (!gripsOn && !altHeld && pick && !dragging) clearPick();
        sendResponse({ ok: true, gripsOn });
        return false;
      }
      if (msg.type === "rdc-get-state") {
        sendResponse({ ok: true, gripsOn, active: active() });
        return false;
      }
      return false;
    });
  } catch (_) { /* the extension was reloaded under this page */ }
})();
