// Recall Page Cleaner — the rule engine.
//
// SHARED FILE. A byte-identical copy lives at
// recall-web-to-pdf/content/cleaner-core.js ("Clean first" in the PDF popup);
// tools/extensions-check.mjs fails if the two drift. Edit one, copy it over.
//
// Pure DOM reading: nothing here changes the page. findCandidates() returns the
// elements a level would remove, each with a short human reason, and the UI (or
// the PDF job) decides what to do with them. The word lists start from the
// Recall app's own web-page import (src/import/web-page.js), which in turn
// started from the clipper's PAGE_CHROME, so all three agree on what an ad, a
// cookie banner or a share bar looks like.
//
// Safe to inject more than once: the second run keeps the first definition.

(() => {
  if (globalThis.__recallCleanerCore) return;

  const AD_TOKENS = new Set([
    "ad", "ads", "advert", "adverts", "advertisement", "advertisements", "advertising", "adslot", "adslots",
    "adunit", "adbox", "adwrap", "adwrapper", "adcontainer", "adsense", "adsbygoogle", "adhesion", "sponsor",
    "sponsored", "sponsors", "promoted", "dfp", "taboola", "outbrain", "revcontent", "mgid", "zergnet", "teads",
    "mediavine", "adthrive", "ezoic", "raptive", "nativo", "sharethrough", "billboard", "leaderboard", "skyscraper"
  ]);
  const AD_SELECTOR = [
    "ins.adsbygoogle", "[data-ad]", "[data-ad-slot]", "[data-ad-client]", "[data-adunit]", "[data-ad-unit]",
    "[data-google-query-id]", "[id^='google_ads']", "[id^='div-gpt-ad']", "[id^='ezoic-pub-ad']", "amp-ad",
    "amp-embed", "amp-sticky-ad"
  ].join(", ");
  const AD_HOSTS = [
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.", "adnxs.com",
    "criteo.com", "criteo.net", "amazon-adsystem.com", "taboola.com", "outbrain.com", "revcontent.com",
    "mgid.com", "zergnet.com", "teads.tv", "adsrvr.org", "pubmatic.com", "rubiconproject.com", "openx.net",
    "moatads.com", "mediavine.com", "adthrive.com"
  ];
  const AD_LABEL_RE = /^(?:advertisement|advertisements|advertising|ad|ads|sponsored(?: content)?|promoted|paid content|story continues below(?: this)? advertisement|continue reading below)$/i;

  const COOKIE_TOKENS = new Set([
    "cookie", "cookies", "consent", "gdpr", "ccpa", "cmp", "onetrust", "didomi", "cookiebot", "usercentrics",
    "truste", "trustarc", "quantcast", "cookielaw", "cookienotice", "cookiebanner", "privacybanner"
  ]);
  const COOKIE_TEXT_RE = /\b(we use cookies|this (web)?site uses cookies|accept (all )?cookies|cookie (policy|settings|preferences)|manage (your )?(cookies|consent|preferences)|your privacy choices|we value your privacy)\b/i;

  const OVERLAY_TOKENS = new Set([
    "modal", "popup", "overlay", "lightbox", "interstitial", "paywall", "regwall", "backdrop", "dialog"
  ]);
  const SHARE_TOKENS = new Set([
    "share", "shares", "sharing", "sharebar", "sharedaddy", "social", "socials", "pinterest", "pinit",
    "sharethis", "addtoany", "a2a", "addthis"
  ]);
  const COMMENT_TOKENS = new Set([
    "comments", "comment", "respond", "disqus", "discussion", "replies", "commentlist"
  ]);
  const RELATED_TOKENS = new Set([
    "related", "recommended", "recommendations", "recommend", "readnext", "trending", "popular", "mostread",
    "recirc", "recirculation", "morestories", "upnext", "youmaylike", "suggested", "outbrain", "taboola"
  ]);
  const NEWSLETTER_TOKENS = new Set([
    "newsletter", "newsletters", "subscribe", "subscription", "signup", "optin", "mailinglist", "mailchimp",
    "emailcapture", "leadgen"
  ]);
  const NEWSLETTER_INNER = "[class*='newsletter' i], [id*='newsletter' i], [class*='subscribe' i], [id*='subscribe' i], [class*='signup' i], [id*='signup' i]";
  const NEWSLETTER_TEXT_RE = /\b(subscribe to (our|the) newsletter|sign up for (our|the) newsletter|get (the|our) newsletter|join (our|the) (mailing list|newsletter)|enter your email)\b/i;

  // Never removed by a rule, and never removed as part of a bigger branch
  // unless the reader asked for exactly that (Reader level, or a manual click).
  const CONTENT_SELECTOR = "pre, table, figure, math, .katex, mjx-container, h1";
  const SKIP_TAGS = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "BASE", "TITLE"]);

  function tokensOf(el) {
    const words = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""} ${el.getAttribute("data-testid") || ""}`;
    // "share-tools" → share, tools; "socialShare" → social, share
    return words.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_\-:.]+/).filter(Boolean);
  }
  function hasToken(el, set) {
    for (const t of tokensOf(el)) if (set.has(t)) return true;
    return false;
  }
  function textLength(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim().length;
  }
  function linkDensity(el) {
    const total = textLength(el);
    if (!total) return 0;
    let links = 0;
    el.querySelectorAll("a").forEach((a) => { links += textLength(a); });
    return links / total;
  }
  function style(el) {
    try { return getComputedStyle(el); } catch { return null; }
  }
  function isVisible(el) {
    const s = style(el);
    if (!s || s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function holdsContent(el, proseLimit = 600) {
    if (textLength(el) > proseLimit) return true;
    return Boolean(el.matches(CONTENT_SELECTOR) || el.querySelector(CONTENT_SELECTOR));
  }

  // ---------------------------------------------------------------- main content

  // A small Readability: paragraphs vote for their parent (and half a vote for
  // the grandparent); the best-scored container wins, widened to the <article>
  // or <main> holding it when that adds little but its title.
  function findMainContent(doc = document) {
    const body = doc.body;
    if (!body) return null;
    const explicit = [...doc.querySelectorAll("[itemprop='articleBody'], article, [role='main'], main")]
      .filter((el) => textLength(el) > 400);
    const scores = new Map();
    const add = (el, n) => { if (el && el !== body && el !== doc.documentElement) scores.set(el, (scores.get(el) || 0) + n); };
    doc.querySelectorAll("p, pre, blockquote, li, td, h2, h3").forEach((p) => {
      const len = textLength(p);
      if (len < 25) return;
      if (p.closest("nav, footer, aside, [role='navigation'], [role='contentinfo']")) return;
      const commas = ((p.textContent || "").match(/,/g) || []).length;
      const score = 1 + Math.min(commas, 6) + Math.min(len / 100, 3);
      add(p.parentElement, score);
      add(p.parentElement && p.parentElement.parentElement, score / 2);
    });
    let best = null;
    let bestScore = 0;
    scores.forEach((score, el) => {
      const adjusted = score * (1 - Math.min(linkDensity(el), 0.9));
      if (adjusted > bestScore) { best = el; bestScore = adjusted; }
    });
    if (!best) return explicit[0] || body;
    // Prefer the article/main that holds the winner, so the headline and byline
    // come along — unless it is a page-wide wrapper several times bigger.
    const holder = best.closest("[itemprop='articleBody'], article, [role='main'], main");
    if (holder && holder !== body && textLength(holder) < textLength(best) * 3 + 1500) best = holder;
    // A headline just above the winner belongs to it.
    let wrap = best;
    for (let i = 0; i < 2 && wrap.parentElement && wrap.parentElement !== body; i += 1) {
      const parent = wrap.parentElement;
      const h1 = parent.querySelector("h1");
      if (h1 && !wrap.contains(h1) && textLength(parent) < textLength(wrap) * 1.6 + 800) wrap = parent;
      else break;
    }
    return wrap;
  }

  // ---------------------------------------------------------------- rules

  function adReason(el) {
    if (el.matches(AD_SELECTOR)) return "Ad";
    if (el.tagName === "IFRAME") {
      const src = (el.getAttribute("src") || "").toLowerCase();
      if (AD_HOSTS.some((h) => src.includes(h))) return "Ad";
      return null;
    }
    if (hasToken(el, AD_TOKENS)) return "Ad";
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length < 40 && AD_LABEL_RE.test(t) && el.children.length <= 3) return "Ad label";
    return null;
  }

  function fixedish(el) {
    const s = style(el);
    return s && (s.position === "fixed" || s.position === "sticky");
  }

  function overlayReason(el) {
    const s = style(el);
    if (!s) return null;
    const vw = innerWidth || 1;
    const vh = innerHeight || 1;
    const r = el.getBoundingClientRect();
    const area = (Math.min(r.width, vw) * Math.min(r.height, vh)) / (vw * vh);
    const isDialog = el.matches("[role='dialog'], [role='alertdialog'], [aria-modal='true'], dialog[open]");
    if (s.position === "fixed" || s.position === "absolute" && Number(s.zIndex) > 100) {
      if (hasToken(el, COOKIE_TOKENS) || COOKIE_TEXT_RE.test((el.textContent || "").slice(0, 3000))) return "Cookie banner";
      // A dim backdrop: covers most of the screen and says nothing.
      if (s.position === "fixed" && area > 0.5 && textLength(el) < 20 && !el.querySelector("img, video, canvas")) return "Backdrop";
      if (isDialog || hasToken(el, OVERLAY_TOKENS)) return "Popup";
      if (s.position === "fixed" && area > 0.3 && Number(s.zIndex) >= 10) return "Overlay";
    }
    if (isDialog && isVisible(el)) return "Popup";
    if (hasToken(el, COOKIE_TOKENS) && textLength(el) < 2000) return "Cookie banner";
    return null;
  }

  function stickyReason(el) {
    const s = style(el);
    if (!s || (s.position !== "fixed" && s.position !== "sticky")) return null;
    // A sticky table header or code caption is part of the content.
    if (el.closest("table, pre, figure")) return null;
    const r = el.getBoundingClientRect();
    if (r.height > innerHeight * 0.4) return null;
    if (r.top <= innerHeight * 0.25) return "Sticky header";
    if (r.bottom >= innerHeight * 0.75) return "Sticky footer";
    return "Floating bar";
  }

  function balancedReason(el) {
    if (hasToken(el, SHARE_TOKENS) && textLength(el) < 400) return "Share buttons";
    if (hasToken(el, COMMENT_TOKENS) || el.matches("#disqus_thread, .comments-area, [data-component='comments']")) return "Comments";
    if (hasToken(el, RELATED_TOKENS) && (linkDensity(el) > 0.3 || el.querySelectorAll("a").length >= 3)) return "Related links";
    if (textLength(el) < 800 && el.querySelector("input, button, a")) {
      if (hasToken(el, NEWSLETTER_TOKENS)) return "Newsletter box";
      // By its words alone only when nothing inside it names itself a
      // newsletter box — otherwise that inner box is the one to take.
      if (NEWSLETTER_TEXT_RE.test((el.textContent || "").slice(0, 800))
          && !el.querySelector(NEWSLETTER_INNER) && el.querySelectorAll("p, div, section, li").length < 8) return "Newsletter box";
    }
    return null;
  }

  // A rule never takes the article, and inside the article it takes only small
  // furniture (an ad slot, a share bar) — never prose, a figure, a table or code.
  function protectedFrom(el, main, reason) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (main && el.contains(main)) return true;
    if (el.closest("[data-recall-cleaner-ui]")) return true;
    const inMain = main && main.contains(el);
    const isAd = reason === "Ad" || reason === "Ad label";
    if (inMain && !isAd && holdsContent(el, 300)) return true;
    if (!inMain && !isAd && holdsContent(el, 1500) && !/Cookie|Popup|Backdrop|Overlay/.test(reason)) return true;
    if (isAd && (el.querySelector("article, main, h1") || textLength(el) > 2500)) return true;
    return false;
  }

  // Keep only the outermost of nested candidates.
  function outermost(list) {
    const els = new Set(list.map((c) => c.el));
    return list.filter((c) => {
      for (let p = c.el.parentElement; p; p = p.parentElement) if (els.has(p)) return false;
      return true;
    });
  }

  // Everything that is not on the path from <body> to `keep`: the siblings of
  // each ancestor. That is a handful of big branches rather than thousands of
  // leaves, which keeps marking and undo cheap.
  function outsideOf(keep, reason = "Outside the article") {
    const out = [];
    for (let node = keep; node && node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sib of node.parentElement.children) {
        if (sib === node || SKIP_TAGS.has(sib.tagName)) continue;
        if (sib.closest("[data-recall-cleaner-ui]") || sib.hasAttribute("data-recall-cleaner-ui")) continue;
        if (!isVisible(sib) && !sib.querySelector("iframe")) continue;
        out.push({ el: sib, reason });
      }
    }
    return out;
  }

  /**
   * The elements `level` would remove.
   * @param {"gentle"|"balanced"|"reader"} level
   * @returns {{el: Element, reason: string}[]}
   */
  function findCandidates(level = "balanced", doc = document) {
    const main = findMainContent(doc);
    const found = [];
    const seen = new Set();
    const push = (el, reason) => {
      if (seen.has(el) || protectedFrom(el, main, reason)) return;
      seen.add(el);
      found.push({ el, reason });
    };
    const all = doc.body ? doc.body.querySelectorAll("*") : [];
    for (const el of all) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const ad = adReason(el);
      if (ad) { push(el, ad); continue; }
      const overlay = overlayReason(el);
      if (overlay) { push(el, overlay); continue; }
      if (level === "gentle") continue;
      if (fixedish(el)) {
        const sticky = stickyReason(el);
        if (sticky) { push(el, sticky); continue; }
      }
      const other = balancedReason(el);
      if (other) push(el, other);
    }
    let list = outermost(found);
    if (level === "reader" && main && main !== doc.body) {
      const outside = outsideOf(main);
      const merged = [...outside, ...list.filter((c) => main.contains(c.el))];
      list = outermost(merged);
    }
    return list.filter((c) => c.el.isConnected);
  }

  // Modals lock the page with overflow:hidden on <html>/<body> (and sometimes a
  // fixed-position body). Returns an undo function.
  function unlockScroll(doc = document) {
    const saved = [];
    for (const el of [doc.documentElement, doc.body]) {
      if (!el) continue;
      const s = style(el);
      if (!s) continue;
      const before = el.getAttribute("style");
      let changed = false;
      if (s.overflow === "hidden" || s.overflowY === "hidden") { el.style.setProperty("overflow", "auto", "important"); changed = true; }
      if (el === doc.body && s.position === "fixed") { el.style.setProperty("position", "static", "important"); changed = true; }
      if (changed) saved.push({ el, before });
    }
    // Classes many modal libraries put on <body> to lock it.
    const lockClasses = ["modal-open", "no-scroll", "noscroll", "overflow-hidden", "scroll-lock", "is-locked"];
    const removed = [];
    for (const el of [doc.documentElement, doc.body]) {
      if (!el) continue;
      lockClasses.forEach((c) => { if (el.classList.contains(c)) { el.classList.remove(c); removed.push([el, c]); } });
    }
    return () => {
      saved.forEach(({ el, before }) => { if (before == null) el.removeAttribute("style"); else el.setAttribute("style", before); });
      removed.forEach(([el, c]) => el.classList.add(c));
    };
  }

  // A selector that finds `el` again on the next visit: a stable id, else the
  // tag and stable classes, anchored to up to three ancestors. Ids and classes
  // that look generated (long digit runs, hashes) are skipped.
  const UNSTABLE = /\d{3,}|^[a-z]{1,3}-?[a-z0-9]{5,}$|[A-Z].*\d|__|--[a-z0-9]{5,}$/;
  const cssEscape = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  function part(el) {
    const id = el.getAttribute("id");
    if (id && !UNSTABLE.test(id) && document.querySelectorAll(`#${cssEscape(id)}`).length === 1) return { sel: `#${cssEscape(id)}`, unique: true };
    const classes = [...el.classList].filter((c) => !UNSTABLE.test(c) && !c.startsWith("rpc-")).slice(0, 3);
    let sel = el.tagName.toLowerCase() + classes.map((c) => `.${cssEscape(c)}`).join("");
    const role = el.getAttribute("role");
    if (!classes.length && role) sel += `[role="${role}"]`;
    return { sel, unique: false };
  }
  function selectorFor(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node !== document.body && depth < 4; depth += 1) {
      const p = part(node);
      parts.unshift(p.sel);
      const sel = parts.join(" > ");
      let count = 0;
      try { count = document.querySelectorAll(sel).length; } catch { return null; }
      if (p.unique || count === 1) return sel;
      node = node.parentElement;
    }
    const sel = parts.join(" > ");
    try {
      const n = document.querySelectorAll(sel);
      // A generic selector that hits half the page is not a rule worth saving.
      return [...n].includes(el) && n.length <= 25 ? sel : null;
    } catch { return null; }
  }

  // Page facts the PDF job and the hand-off use.
  function pageFacts(doc = document) {
    const meta = (name) => {
      const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
      return el ? (el.getAttribute("content") || "").trim() : "";
    };
    let ld = {};
    for (const s of doc.querySelectorAll("script[type='application/ld+json']")) {
      try {
        const data = JSON.parse(s.textContent);
        const items = [].concat(data["@graph"] || data);
        const article = items.find((i) => i && /Article|BlogPosting|Report|WebPage/.test([].concat(i["@type"]).join(" ")));
        if (article) { ld = article; break; }
      } catch { /* not every ld+json parses */ }
    }
    const author = [].concat(ld.author || []).map((a) => (typeof a === "string" ? a : a && a.name)).filter(Boolean).join(", ")
      || meta("author") || meta("article:author") || meta("parsely-author");
    const h1 = doc.querySelector("h1");
    const ogTitle = meta("og:title");
    let title = (ld.headline || ogTitle || doc.title || (h1 && h1.textContent) || "").replace(/\s+/g, " ").trim();
    const site = meta("og:site_name") || (ld.publisher && ld.publisher.name) || location.hostname.replace(/^www\./, "");
    // "Headline | Site Name" → "Headline"
    if (site && title.length > site.length + 3) {
      const re = new RegExp(`\\s*[|\\-–—·:]\\s*${site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
      title = title.replace(re, "");
    }
    return {
      title: title || location.hostname,
      site,
      author,
      published: ld.datePublished || meta("article:published_time") || meta("date") || "",
      description: meta("description") || meta("og:description"),
      keywords: meta("keywords") || [].concat(ld.keywords || []).join(", "),
      url: (doc.querySelector("link[rel='canonical']") || {}).href || location.href
    };
  }

  globalThis.__recallCleanerCore = {
    version: 1,
    findCandidates,
    findMainContent,
    outsideOf,
    unlockScroll,
    selectorFor,
    pageFacts,
    textLength,
    holdsContent
  };
})();
