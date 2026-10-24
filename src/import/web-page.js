// A saved web page (.html or .mhtml) → Markdown, with the ads and the page's
// furniture taken out.
//
// Saving the page is how something you are signed in to gets into Recall on a
// phone: Chrome on Android's ⋮ → Download page writes an .mhtml of exactly what
// you were looking at, with your session's content in it. The same cleaner reads
// a page a link import fetched (src/import/url.js), so both come out the same.
//
// The rules are the clipper's, ported (recall-clipper/content/picker.js):
// stripHidden and scrubNoise for what a reader never sees, PAGE_CHROME and
// stripPageChrome for the furniture and its guards, bestImageUrl for lazy-loaded
// pictures. The clipper strips furniture only when the reader has not picked
// anything; here nothing was picked, so it always runs — and the review screen
// offers the page as it was, should a rule have caught something real.

import { ensureTurndown } from "../core/lib-loader.js?v=__BUILD__";
import { htmlToMarkdown } from "./html-to-markdown.js?v=__BUILD__";
import {
  bytesToLatin1,
  cleanPageTitle,
  decodeBytes,
  isHttpUrl,
  looksLikeMhtml,
  parseMhtml,
  savedFromUrl,
  sniffHtmlCharset
} from "./web-text.js?v=__BUILD__";

// ── Reading the file ───────────────────────────────────────────────────────

export function readFileBytes(file) {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(new Uint8Array(reader.result)));
    reader.addEventListener("error", () => reject(new Error(`Could not read ${file.name}`)));
    reader.readAsArrayBuffer(file);
  });
}

// { html, baseUrl } from a saved page, whichever kind it is.
export async function readWebPageFile(file) {
  const bytes = await readFileBytes(file);
  const latin1 = bytesToLatin1(bytes);
  if (looksLikeMhtml(file.name, file.type, latin1.slice(0, 4096))) {
    const page = parseMhtml(latin1);
    if (page) return page;
  }
  const html = decodeBytes(bytes, sniffHtmlCharset(bytes));
  return { html, baseUrl: savedFromUrl(html) };
}

// ── What gets taken out ────────────────────────────────────────────────────

// Never content, in either version of the page.
export const ALWAYS_REMOVED_SELECTOR = [
  "script", "style", "link", "meta", "noscript", "template", "iframe", "frame", "frameset", "object", "embed",
  "input", "select", "textarea", "button", "dialog", "canvas", "audio", "video", "source", "track", "map"
].join(", ");

// What a reader never sees. Kept when it carries a picture, a table or code
// (decorative aria-hidden on a real figure), or a formula's source (MathML and
// KaTeX keep the real TeX in a hidden subtree, which html-to-markdown reads).
export const HIDDEN_SELECTOR = [
  "[hidden]", "[aria-hidden='true']", "[role='tooltip']",
  ".sr-only", ".visually-hidden", ".visuallyhidden", ".screen-reader-text", ".a11y-hidden"
].join(", ");

export const KEEP_WHEN_HIDDEN_SELECTOR = "img, picture, pre, table, video, math, annotation, .katex, mjx-container";

// Class or id WORDS (split on "-", "_" and spaces, so "header" and "read" never
// match "ad") that mark an advertisement. The network names are there because
// food and news sites wrap every slot in their ad network's own class.
export const AD_TOKENS = new Set([
  "ad", "ads", "advert", "adverts", "advertisement", "advertisements", "advertising", "adslot", "adslots", "adunit",
  "adbox", "adwrap", "adwrapper", "adcontainer", "adsense", "adsbygoogle", "adhesion", "sponsor", "sponsored",
  "sponsors", "promo", "promoted", "dfp", "taboola", "outbrain", "revcontent", "mgid", "zergnet", "teads",
  "mediavine", "adthrive", "ezoic", "raptive", "nativo", "sharethrough"
]);

export const AD_SELECTOR = [
  "ins.adsbygoogle", "[data-ad]", "[data-ad-slot]", "[data-ad-client]", "[data-adunit]", "[data-ad-unit]",
  "[data-google-query-id]", "[id^='google_ads']", "[id^='div-gpt-ad']", "[id^='ezoic-pub-ad']", "amp-ad", "amp-embed"
].join(", ");

export const AD_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.", "adnxs.com",
  "criteo.com", "criteo.net", "amazon-adsystem.com", "taboola.com", "outbrain.com", "revcontent.com", "mgid.com",
  "zergnet.com", "teads.tv", "adsrvr.org", "pubmatic.com", "rubiconproject.com", "openx.net", "moatads.com",
  "scorecardresearch.com", "quantserve.com", "facebook.com/tr", "mediavine.com", "adthrive.com"
];

// A block whose whole text is one of these is the label over an ad slot.
export const AD_LABEL_RE = /^(?:advertisement|advertisements|advertising|ad|ads|sponsored(?: content)?|promoted|paid content|story continues below(?: this)? advertisement|continue reading below)$/i;

// The page's furniture: the clipper's PAGE_CHROME, as roles and structure...
export const CLUTTER_SELECTOR = [
  "nav", "header", "footer", "aside",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']", "[role='search']",
  "[role='dialog']", "[role='alertdialog']"
].join(", ");

// ...and as class or id words.
export const CLUTTER_TOKENS = new Set([
  "cookie", "cookies", "consent", "gdpr", "ccpa", "newsletter", "subscribe", "subscription", "signup", "optin",
  "share", "sharing", "sharedaddy", "social", "pinterest", "pinit", "related", "recommended", "recommendations",
  "readnext", "comments", "comment", "respond", "disqus", "breadcrumb", "breadcrumbs", "sidebar", "widget",
  "widgets", "popup", "modal", "overlay", "skip", "navbar", "menu", "masthead", "jump", "toolbar"
]);

export function classTokens(el) {
  const words = `${el.getAttribute("class") || ""} ${el.getAttribute("id") || ""}`.toLowerCase();
  return words.split(/[\s_-]+/).filter(Boolean);
}

export function textLength(el) {
  return (el.textContent || "").replace(/\s+/g, " ").trim().length;
}

// Furniture is only ever small. A branch holding real prose, a table, code or a
// figure is content, whatever its class says (the clipper's stripPageChrome) —
// and a <header> holding the page's title stays with it.
export function holdsContent(el, proseLimit = 600) {
  if (textLength(el) > proseLimit) return true;
  return Boolean(el.querySelector("pre, table, figure, h1"));
}

// An ad slot never holds the article. A class word like "ad-free" on a site's
// outer wrapper must not take the whole page with it.
export function holdsArticle(el) {
  if (el.matches("article, main, body, html")) return true;
  if (el.querySelector("article, main, h1")) return true;
  return textLength(el) > 2000;
}

function removeEach(nodes, keep) {
  let removed = 0;
  for (const node of nodes) {
    if (!node.isConnected || (keep && keep(node))) continue;
    node.remove();
    removed += 1;
  }
  return removed;
}

export function isAdUrl(url) {
  const text = String(url || "").toLowerCase();
  return AD_HOSTS.some((host) => text.includes(host));
}

// ── Pictures ───────────────────────────────────────────────────────────────

// A src that shows nothing: empty, a short data: URI (a lazy-load placeholder),
// or one of the blank-pixel files lazy-loaders swap in.
export function isPlaceholderSrc(url) {
  const text = String(url || "").trim();
  if (!text) return true;
  if (/^data:/i.test(text)) return text.length < 2048;
  return /(?:^|\/)(?:blank|spacer|pixel|transparent|placeholder|lazy[-_]?load\w*)\.(?:gif|png|svg)(?:$|\?)/i.test(text);
}

// The widest candidate in a srcset ("a.jpg 400w, b.jpg 1200w" → b.jpg).
export function widestFromSrcset(srcset) {
  const candidates = String(srcset || "")
    .split(/,\s+(?=\S)/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, descriptor = ""] = part.split(/\s+/);
      const width = /^(\d+)w$/.exec(descriptor);
      const density = /^([\d.]+)x$/.exec(descriptor);
      return { url, weight: width ? Number(width[1]) : density ? Number(density[1]) * 1000 : 1 };
    })
    .filter((candidate) => candidate.url);
  if (!candidates.length) return "";
  return candidates.reduce((best, candidate) => (candidate.weight > best.weight ? candidate : best)).url;
}

export const LAZY_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-actualsrc", "data-hi-res-src", "data-full-src", "data-orig-src", "data-pin-media"];

// The address worth keeping: a lazy-loader's real address over its placeholder,
// and the widest srcset candidate over the src — a src is usually a small
// default, and a picture in a note is compressed to a sensible size anyway.
export function bestImageUrl(img) {
  for (const attr of LAZY_ATTRS) {
    const value = img.getAttribute(attr);
    if (value && !isPlaceholderSrc(value)) return value;
  }
  const fromSrcset = widestFromSrcset(img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset") || img.getAttribute("srcset"));
  if (fromSrcset && !isPlaceholderSrc(fromSrcset)) return fromSrcset;
  const src = img.getAttribute("src") || "";
  if (!isPlaceholderSrc(src)) return src;
  const picture = img.closest("picture");
  if (picture) {
    for (const source of picture.querySelectorAll("source")) {
      const candidate = widestFromSrcset(source.getAttribute("data-srcset") || source.getAttribute("srcset"));
      if (candidate && !isPlaceholderSrc(candidate)) return candidate;
    }
  }
  return "";
}

// Where a link or picture points, made absolute. "" when it cannot be: a
// relative address with no page address to resolve it against, a file:
// address, or a picture in the folder a desktop "Save page as" writes beside
// the .html — that folder never comes along with the file.
export function absoluteUrl(url, baseUrl) {
  const text = String(url || "").trim();
  if (!text || /^(?:javascript|file|blob|about):/i.test(text)) return "";
  if (/^data:/i.test(text)) return text;
  if (/(?:^|\/)[^/]*_files\//i.test(text) && !isHttpUrl(text)) return "";
  if (isHttpUrl(text)) return text;
  if (/^\/\//.test(text)) return `https:${text}`;
  if (!baseUrl) return "";
  try {
    return new URL(text, baseUrl).href;
  } catch (_) {
    return "";
  }
}

// A lazy-loaded picture often keeps its real <img> in a <noscript> beside a
// placeholder. DOMParser runs with scripting off, so that <noscript> was parsed
// as markup: put its picture in the placeholder's place.
export function liftNoscriptImages(root) {
  for (const noscript of Array.from(root.querySelectorAll("noscript"))) {
    const img = noscript.querySelector("img");
    if (!img) continue;
    const before = noscript.previousElementSibling;
    if (before && before.tagName === "IMG" && !bestImageUrl(before)) before.remove();
    noscript.replaceWith(img);
  }
}

// Every picture resolved to the one address it should show; the ones that can
// not be shown are removed and counted.
export function resolvePictures(root, baseUrl) {
  let dropped = 0;
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const width = Number(img.getAttribute("width"));
    const height = Number(img.getAttribute("height"));
    const raw = bestImageUrl(img);
    if ((width && width <= 2 && height && height <= 2) || isAdUrl(raw)) {
      img.remove();
      continue;
    }
    const url = absoluteUrl(raw, baseUrl);
    if (!url || /^data:/i.test(url) && url.length < 2048) {
      // Nothing usable to point at. A real picture (one that had an address)
      // is worth counting; a bare placeholder is not.
      if (raw) dropped += 1;
      img.remove();
      continue;
    }
    for (const attr of ["srcset", "sizes", "loading", "decoding", ...LAZY_ATTRS, "data-srcset", "data-lazy-srcset"]) img.removeAttribute(attr);
    img.setAttribute("src", url);
  }
  // <picture> wrappers have done their job once the <img> holds the address.
  for (const picture of Array.from(root.querySelectorAll("picture"))) {
    const img = picture.querySelector("img");
    if (img) picture.replaceWith(img);
    else picture.remove();
  }
  return dropped;
}

// Links made absolute, so they still go somewhere once the page is a note. One
// that cannot be (a jump within the page, a relative link with nowhere to
// resolve it) is unwrapped, keeping its words.
export function resolveLinks(root, baseUrl) {
  for (const a of Array.from(root.querySelectorAll("a"))) {
    const href = a.getAttribute("href") || "";
    const url = href.startsWith("#") ? "" : absoluteUrl(href, baseUrl);
    if (url && !/^data:/i.test(url)) {
      a.setAttribute("href", url);
      continue;
    }
    a.replaceWith(...a.childNodes);
  }
}

// ── The passes ─────────────────────────────────────────────────────────────

// MathJax 2 keeps each formula's TeX in a <script type="math/tex">, which the
// script pass below would delete. Turned into the $…$ text Recall writes.
export function keepMathJaxSource(root) {
  for (const script of Array.from(root.querySelectorAll("script[type^='math/tex']"))) {
    const tex = (script.textContent || "").trim();
    if (!tex) continue;
    const display = /mode\s*=\s*display/i.test(script.getAttribute("type") || "");
    script.replaceWith(root.ownerDocument.createTextNode(display ? `$$${tex}$$` : `$${tex}$`));
  }
  // The rendered copy beside it is the preview MathJax drew; the source above
  // replaces it.
  root.querySelectorAll(".MathJax_Preview, .MathJax, .MathJax_Display").forEach((node) => node.remove());
}

// What both versions of the page lose: code, controls and what nobody sees.
export function removeInvisible(root) {
  liftNoscriptImages(root);
  keepMathJaxSource(root);
  removeEach(root.querySelectorAll(ALWAYS_REMOVED_SELECTOR));
  removeEach(root.querySelectorAll(HIDDEN_SELECTOR), (el) => Boolean(el.querySelector(KEEP_WHEN_HIDDEN_SELECTOR)));
  removeEach(Array.from(root.querySelectorAll("[style]")).filter((el) => {
    const style = (el.getAttribute("style") || "").replace(/\s+/g, "").toLowerCase();
    return style.includes("display:none") || style.includes("visibility:hidden");
  }), (el) => Boolean(el.querySelector(KEEP_WHEN_HIDDEN_SELECTOR)));
  // Comments are not content and can be large (conditional IE blocks).
  const walker = root.ownerDocument.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
  comments.forEach((node) => node.remove());
}

export function removeAds(root) {
  let removed = removeEach(root.querySelectorAll(AD_SELECTOR), holdsArticle);
  removed += removeEach(Array.from(root.querySelectorAll("[class], [id]")).filter((el) => classTokens(el).some((word) => AD_TOKENS.has(word))), holdsArticle);
  // A link to an ad network, and what it wraps.
  removed += removeEach(Array.from(root.querySelectorAll("a[href]")).filter((a) => isAdUrl(a.getAttribute("href"))), holdsArticle);
  // "Advertisement" over a slot whose own markup said nothing: the label and the
  // small block it labels go together.
  for (const el of Array.from(root.querySelectorAll("div, span, p, section, aside, figcaption, small, strong"))) {
    if (!el.isConnected || el.children.length > 1) continue;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!AD_LABEL_RE.test(text)) continue;
    const parent = el.parentElement;
    const target = parent && parent !== root && !holdsArticle(parent) && textLength(parent) <= 200 ? parent : el;
    target.remove();
    removed += 1;
  }
  return removed;
}

export function removeClutter(root) {
  let removed = removeEach(root.querySelectorAll(CLUTTER_SELECTOR), (el) => holdsContent(el));
  removed += removeEach(
    Array.from(root.querySelectorAll("[class], [id]")).filter((el) => classTokens(el).some((word) => CLUTTER_TOKENS.has(word))),
    (el) => el.matches("article, main, body, html") || holdsContent(el)
  );
  return removed;
}

// The part of the page that is the article: the smallest of the usual
// containers that still holds nearly everything the largest one does (so an
// <article> is chosen over the <main> around it), as long as that is a fair
// share of the page. Otherwise the whole page, already cleaned.
export const MAIN_CONTENT_SELECTOR = [
  "article", "main", "[role='main']", "[itemprop='articleBody']", ".entry-content", ".post-content",
  ".article-body", ".article-content", ".post-body", ".story-body", ".recipe-content"
].join(", ");

export function mainContent(body) {
  const total = textLength(body);
  const candidates = Array.from(body.querySelectorAll(MAIN_CONTENT_SELECTOR))
    .map((el) => ({ el, size: textLength(el) }))
    .filter((candidate) => candidate.size >= 200);
  if (!candidates.length) return body;
  const largest = candidates.reduce((best, candidate) => (candidate.size > best.size ? candidate : best));
  if (largest.size < 0.4 * total) return body;
  const fits = candidates.filter((candidate) => candidate.size >= 0.85 * largest.size && largest.el.contains(candidate.el));
  return fits.reduce((best, candidate) => (candidate.size < best.size ? candidate : best), largest).el;
}

export function pageTitle(doc) {
  const og = doc.querySelector("meta[property='og:title'], meta[name='og:title'], meta[name='twitter:title']")?.getAttribute("content");
  return cleanPageTitle(og || doc.querySelector("title")?.textContent || "");
}

// The page's own address, when the file did not say: what the HTML says about
// itself.
export function pageAddress(doc) {
  const candidates = [
    doc.querySelector("base[href]")?.getAttribute("href"),
    doc.querySelector("meta[property='og:url']")?.getAttribute("content"),
    doc.querySelector("link[rel='canonical']")?.getAttribute("href")
  ];
  return candidates.find((url) => isHttpUrl(url)) || "";
}

// HTML of `root`, with the page's title as its heading when it has none.
export function withTitle(root, title) {
  const html = root.innerHTML;
  if (!title || root.querySelector("h1")) return html;
  const holder = root.ownerDocument.createElement("h1");
  holder.textContent = title;
  return `${holder.outerHTML}\n${html}`;
}

// Whitespace a converted page carries that a note does not want: runs of blank
// lines where removed blocks used to be, and trailing spaces.
export function tidyPageMarkdown(markdown) {
  return String(markdown || "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// A page's HTML → { cleaned, full, title, baseUrl, removed: { ads, clutter, pictures } }.
// Null when the Markdown converter cannot be loaded (its first use needs the
// network), so the caller can say so instead of importing raw HTML.
export async function webPageToMarkdown({ html, baseUrl = "", title = "" }) {
  if (!(await ensureTurndown())) return null;
  // DOMParser builds an inert document: none of the page's scripts run and
  // none of its pictures or trackers load while it is read.
  const parse = () => new DOMParser().parseFromString(String(html || ""), "text/html");
  const probe = parse();
  const address = isHttpUrl(baseUrl) ? baseUrl : pageAddress(probe);
  const heading = cleanPageTitle(title) || pageTitle(probe);

  const convert = (root) => tidyPageMarkdown(htmlToMarkdown(withTitle(root, heading)));

  const fullDoc = parse();
  removeInvisible(fullDoc.body);
  resolvePictures(fullDoc.body, address);
  resolveLinks(fullDoc.body, address);
  const full = convert(fullDoc.body);

  const doc = parse();
  removeInvisible(doc.body);
  const ads = removeAds(doc.body);
  const clutter = removeClutter(doc.body);
  const pictures = resolvePictures(doc.body, address);
  resolveLinks(doc.body, address);
  const cleaned = convert(mainContent(doc.body));

  return { cleaned: cleaned || full, full, title: heading, baseUrl: address, removed: { ads, clutter, pictures } };
}
