// EPUB import: one deck per chapter, with the book's own table of contents as
// the source of chapter titles.
//
// Titles come from the TOC rather than from each chapter's heading because
// converted and scanned books routinely leave those blank or set every one to
// the same placeholder. Images are uploaded as the import runs, with retries,
// since a book can carry hundreds and a single failure should not lose the
// whole import.

import { el } from "../core/dom.js?v=__BUILD__";
import { ensureJsZip } from "../core/lib-loader.js?v=__BUILD__";
import { optimizeImage, storageFolderSlug, storageGroupId, uploadImageToSupabase } from "../images/upload.js?v=__BUILD__";
import { htmlToMarkdown } from "./html-to-markdown.js?v=__BUILD__";
import { decksUnderFolder } from "../library/folder-tree.js?v=__BUILD__";
import { FOLDER_SEP, addKnownFolder, normalizeDeckCategory } from "../library/folders.js?v=__BUILD__";
import { saveDeckToLibrary } from "../library/local-library.js?v=__BUILD__";
import { currentMyDecksFolder } from "../library/my-decks-menu.js?v=__BUILD__";
import { setMyDecksCwd, setMyDecksView } from "../library/my-decks-prefs.js?v=__BUILD__";
import { renderMyDecksList } from "../library/my-decks-render.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { enhanceRenderedMarkdown } from "../render/enhance.js?v=__BUILD__";
import { markdownToSafeHtml } from "../render/preprocess.js?v=__BUILD__";
import { lastSaveErrorWasQuota, persistWorkingDeck } from "../storage/quota.js?v=__BUILD__";
import { openMyDecksPanel } from "../ui/deck-header.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";

export function normalizedArchiveName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function isMarkdownName(name) {
  return /\.(md|markdown|mdown|mkdn|txt)$/i.test(normalizedArchiveName(name).split("?")[0]);
}

export function isZipName(name) {
  return /\.zip$/i.test(normalizedArchiveName(name).split("?")[0]);
}

export function isJsonName(name) {
  return /\.json$/i.test(normalizedArchiveName(name).split("?")[0]);
}

export function isEpubName(name) {
  return /\.epub$/i.test(normalizedArchiveName(name).split("?")[0]);
}

export function epubDirname(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

// True for an href that already points outside the book (a remote image, a
// data: URI) — it needs no zip lookup and must survive into the markdown as-is.
export function isExternalEpubHref(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(href || "").trim());
}

export function joinEpubPath(baseDir, relative) {
  const stack = baseDir ? baseDir.split("/") : [];
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

// Resolves a relative href against a base directory inside the zip (both EPUB
// manifest hrefs and in-chapter image srcs are relative like this). Hrefs are
// URLs, so they arrive percent-encoded ("a%20b.jpg") while the zip entry they
// name is literal ("a b.jpg") — decode, or every book with a space or a
// non-ASCII character in a filename silently loses that file. `.raw` keeps the
// undecoded form for the rare archive whose entry names are encoded too.
export function resolveEpubPath(baseDir, href) {
  if (!href) return "";
  const raw = href.split("#")[0].trim();
  if (!raw || isExternalEpubHref(raw)) return raw;
  return joinEpubPath(baseDir, normalizedArchiveName(raw));
}

export function resolveEpubPathRaw(baseDir, href) {
  if (!href) return "";
  const raw = href.split("#")[0].trim();
  if (!raw || isExternalEpubHref(raw)) return raw;
  return joinEpubPath(baseDir, raw);
}

// zip.file() by resolved path, tolerating either naming convention.
export function epubZipFile(zip, path, rawPath = "") {
  return zip.file(path) || (rawPath && rawPath !== path ? zip.file(rawPath) : null);
}

// Finds every element with a given local name, ignoring namespace prefixes —
// EPUB package documents mix the OPF namespace with prefixed Dublin Core
// (dc:title) and manifest items sometimes carry no prefix at all, so a plain
// CSS tag selector on the parsed XML doc isn't reliable across parsers.
export function epubElementsByLocalName(doc, localName) {
  return Array.from(doc.getElementsByTagName("*")).filter((el) => el.localName === localName);
}

export async function readEpubXml(zip, path, rawPath = "") {
  const entry = epubZipFile(zip, path, rawPath);
  if (!entry) throw new Error(`Missing ${path} in EPUB`);
  const text = await entry.async("text");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(`Could not parse ${path}`);
  return doc;
}

// Finds the package document (.opf) path from META-INF/container.xml.
export async function parseEpubContainer(zip) {
  const doc = await readEpubXml(zip, "META-INF/container.xml");
  const rootfile = epubElementsByLocalName(doc, "rootfile").find((el) => el.hasAttribute("full-path"));
  const href = rootfile?.getAttribute("full-path");
  if (!href) throw new Error("EPUB container.xml has no rootfile");
  return { path: resolveEpubPath("", href), rawPath: resolveEpubPathRaw("", href) };
}

// Parses the package document → book title, author, manifest
// (id -> {path, rawPath, mediaType}), and the spine in reading order.
export async function parseEpubPackage(zip, opf) {
  const doc = await readEpubXml(zip, opf.path, opf.rawPath);
  const opfDir = epubDirname(opf.path);
  const opfDirRaw = epubDirname(opf.rawPath);

  const title = epubElementsByLocalName(doc, "title")[0]?.textContent?.trim() || "";
  const author = epubElementsByLocalName(doc, "creator")[0]?.textContent?.trim() || "";

  const manifest = new Map();
  epubElementsByLocalName(doc, "item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const mediaType = item.getAttribute("media-type") || "";
    if (!id || !href) return;
    manifest.set(id, {
      path: resolveEpubPath(opfDir, href),
      rawPath: resolveEpubPathRaw(opfDirRaw, href),
      mediaType
    });
  });

  const spine = [];
  epubElementsByLocalName(doc, "itemref").forEach((itemref) => {
    const idref = itemref.getAttribute("idref");
    const entry = idref && manifest.get(idref);
    if (entry) spine.push(entry);
  });

  // Locates the table of contents: an EPUB3 nav document (the manifest item
  // flagged properties="nav") if present, else the EPUB2 NCX the spine's toc
  // attribute points at. Either is the authoritative, human-authored source
  // for chapter titles — far more reliable than sniffing a body heading or a
  // per-chapter <title>, which many converted/scanned books leave blank or
  // set to the same placeholder ("Unknown", "Untitled") on every page.
  let tocPath = "", tocRawPath = "";
  const navItem = epubElementsByLocalName(doc, "item").find((item) =>
    (item.getAttribute("properties") || "").split(/\s+/).includes("nav")
  );
  if (navItem?.getAttribute("href")) {
    tocPath = resolveEpubPath(opfDir, navItem.getAttribute("href"));
    tocRawPath = resolveEpubPathRaw(opfDirRaw, navItem.getAttribute("href"));
  } else {
    const tocId = epubElementsByLocalName(doc, "spine")[0]?.getAttribute("toc");
    const tocEntry = tocId && manifest.get(tocId);
    if (tocEntry) {
      tocPath = tocEntry.path;
      tocRawPath = tocEntry.rawPath;
    }
  }

  return { title, author, manifest, spine, tocPath, tocRawPath };
}

// Reads the EPUB3 nav doc / EPUB2 NCX located above into an ordered list of
// { path, anchorId, title } entries — one per TOC entry, in book reading
// order. anchorId is "" for an entry that names an entire spine file (a
// bare href with no #fragment) and non-empty for one that names a specific
// point *inside* a shared file (many real books — this NCX included — mix
// both: a bare entry per "chapter" file, and several anchored entries for
// finer sub-headings that live inside one physical page alongside other
// sub-headings). planEpubChapters below is what actually turns this list
// into chapter boundaries, splitting mid-file where an anchor demands it.
export async function parseEpubToc(zip, pkg) {
  const entries = [];
  if (!pkg.tocPath) return entries;
  let doc;
  try {
    doc = await readEpubXml(zip, pkg.tocPath, pkg.tocRawPath);
  } catch (error) {
    console.warn("EPUB table of contents could not be parsed, falling back to headings", error);
    return entries;
  }
  const tocDir = epubDirname(pkg.tocPath);
  const seen = new Set();

  const addEntry = (href, label) => {
    const text = String(label || "").trim().replace(/\s+/g, " ");
    if (!href || !text) return;
    const hashIndex = href.indexOf("#");
    const anchorId = hashIndex === -1 ? "" : decodeURIComponent(href.slice(hashIndex + 1).trim());
    const path = resolveEpubPath(tocDir, href);
    if (!path) return;
    const key = `${path}#${anchorId}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ path, anchorId, title: text });
  };

  // EPUB3 nav: <nav epub:type="toc">…<a href="…">Label</a>…</nav>
  const navEls = epubElementsByLocalName(doc, "nav");
  const tocNav = navEls.find((nav) =>
    (nav.getAttribute("epub:type") || nav.getAttribute("type") || "").includes("toc")
  ) || navEls[0];
  if (tocNav) {
    epubElementsByLocalName(tocNav, "a").forEach((a) => addEntry(a.getAttribute("href"), a.textContent));
  }

  // EPUB2 NCX: <navPoint><navLabel><text>Label</text></navLabel><content src="…"/></navPoint>
  epubElementsByLocalName(doc, "navPoint").forEach((navPoint) => {
    const label = epubElementsByLocalName(navPoint, "text")[0]?.textContent;
    const src = epubElementsByLocalName(navPoint, "content")[0]?.getAttribute("src");
    addEntry(src, label);
  });

  return entries;
}

// Placeholder text some EPUB-generation tools stamp into every chapter's
// <head><title> when the real per-page title wasn't preserved — treated as
// "no title" rather than surfaced verbatim (which is what previously made
// most chapters of a converted book show up as decks literally named
// "Unknown").
export const GENERIC_EPUB_TITLE_RE = /^(unknown|untitled|no\s*title|n\/a|null|undefined)$/i;

export function isGenericEpubTitle(text) {
  return GENERIC_EPUB_TITLE_RE.test(String(text || "").trim());
}

// Calibre-converted books commonly wrap an entire page's text in <h1> purely
// as a page-break styling hook, not because it's a real heading — so a body
// heading (or a stray <title>) longer than any real chapter title would be
// is discarded rather than trusted, falling through to the next candidate.
export const MAX_EPUB_TITLE_LENGTH = 120;

export function normalizeEpubTitleCandidate(text) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (!value || value.length > MAX_EPUB_TITLE_LENGTH || isGenericEpubTitle(value)) return "";
  return value;
}

// Shared title-resolution priority used by both the real import and the
// table-of-contents preview shown before it starts, so the preview never
// shows a chapter name the actual import wouldn't also produce: the book's
// own table of contents beats a visible body heading, which beats the
// chapter file's own <title> (skipped when generic or implausibly long).
export function epubChapterRawTitle(headingText, docTitleText, tocTitle, chapterNumber) {
  const headingTitle = normalizeEpubTitleCandidate(headingText);
  const docTitle = normalizeEpubTitleCandidate(docTitleText);
  return tocTitle || headingTitle || docTitle || `Chapter ${chapterNumber}`;
}

// Hands control back to the browser so progress-modal updates actually paint
// between heavy steps — without this, a chain of promises that each resolve
// near-instantly (a cached zip read, a tiny parse) runs back-to-back as
// microtasks and the page never gets to repaint, which is what made earlier
// imports look frozen even though work was genuinely progressing.
// requestAnimationFrame is the right yield when visible, but it does NOT fire
// in a background tab — on its own it would hang the whole import the moment
// the user switched away mid-book, so fall back to a timer when hidden.
export function epubYield() {
  if (typeof document !== "undefined" && document.hidden) {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// One image, retried before being given up on. An illustrated book is
// hundreds of uploads back-to-back — exactly what trips a storage rate limiter
// or catches a transient network blip — and unlike a one-off paste the user
// can just redo, a single silent failure here is a figure permanently missing
// from the middle of a chapter. So back off and try again rather than
// dropping the image on the first refusal. Errors that re-trying cannot fix
// (not signed in, or the request itself being rejected) fail out immediately.
export const EPUB_IMAGE_UPLOAD_ATTEMPTS = 4;

export const EPUB_IMAGE_RETRY_BASE_MS = 600;

// A sleep that ends early the moment the import is cancelled, instead of making
// the user wait out the full backoff. On a low network every upload attempt
// already burns the full CLOUD_TIMEOUT_MS before failing, so an un-abortable
// backoff on top of that is exactly what made Cancel feel unresponsive there.
export function cancellableDelay(ms, progress) {
  return new Promise((resolve) => {
    const step = 150;
    let waited = 0;
    const tick = () => {
      if (progress?.cancelled() || waited >= ms) return resolve();
      waited += step;
      setTimeout(tick, Math.min(step, ms - waited + step));
    };
    tick();
  });
}

export async function uploadEpubImageWithRetry(file, progress, destination = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadImageToSupabase(file, destination);
    } catch (error) {
      const worthRetrying = error?.message !== "NOT_SIGNED_IN" && !error?.authFailed;
      if (!worthRetrying || attempt >= EPUB_IMAGE_UPLOAD_ATTEMPTS) throw error;
      // Cancelled mid-run — stop retrying immediately rather than sitting
      // through more doomed attempts the user has already backed out of.
      if (progress?.cancelled()) throw error;
      // 600ms, 1.2s, 2.4s — enough for a per-minute rate limit window to
      // drain a little between attempts instead of hammering through it and
      // burning every remaining image in the book. Abortable so a cancel
      // during the wait takes effect at once.
      await cancellableDelay(EPUB_IMAGE_RETRY_BASE_MS * 2 ** (attempt - 1), progress);
      if (progress?.cancelled()) throw error;
    }
  }
}

// Uploads every manifest image through the existing optimize+Supabase Storage
// pipeline, returning { urlMap: Map(zip path -> hosted URL), failed: [zip path], reason }.
// An image that still won't upload after retries is left out of the map, and
// epubContainerToMarkdown then drops that <img> rather than failing the whole
// book — but the paths and the last failure message come back so the import can
// tell the user how many figures are missing and *why*, instead of leaving them
// to notice the gaps themselves and guess. `reason` matters more than the count:
// every image vanishing is almost always one systemic cause (a lost session,
// a rate limit), and the message is what makes that fixable.
// `folder` is this import run's own bucket folder — every figure in the book
// lands there and nowhere else, so the whole run can be inspected or removed as
// one unit.
export async function uploadEpubImages(zip, imageEntries, progress, folder = null) {
  const urlMap = new Map();
  const failed = [];
  let reason = "";
  for (let i = 0; i < imageEntries.length; i++) {
    const { path, rawPath, mediaType } = imageEntries[i];
    const label = `Uploading images ${i + 1}/${imageEntries.length}…`;
    setStatus(label);
    progress?.update(label, i / Math.max(imageEntries.length, 1));
    await epubYield();
    if (progress?.cancelled()) return { urlMap, failed, reason };
    const entry = epubZipFile(zip, path, rawPath);
    if (!entry) continue;
    try {
      const blob = await entry.async("blob");
      const name = path.split("/").pop() || `image-${i}`;
      const file = new File([blob], name, { type: mediaType || blob.type || "image/jpeg" });
      const optimized = await optimizeImage(file);
      // Keep the book's own filename so a figure is identifiable in the bucket,
      // behind a zero-padded index. The index both preserves the book's image
      // order in an alphabetically-sorted listing and guarantees uniqueness
      // within the folder — EPUBs routinely reuse a basename across
      // subdirectories (images/fig1.png and cover/fig1.png), and upsert is off,
      // so unprefixed names would collide and lose figures.
      const storageName = `${String(i + 1).padStart(4, "0")}-${storageFolderSlug(
        name.replace(/\.[^.]+$/, ""), "image"
      )}`;
      urlMap.set(path, await uploadEpubImageWithRetry(optimized, progress, { folder, name: storageName }));
    } catch (error) {
      // Cancelled mid-upload (uploadEpubImageWithRetry bails out of its backoff
      // on cancel): stop the run without counting this image as a real failure —
      // the user chose to stop, it isn't missing data to warn them about.
      if (progress?.cancelled()) return { urlMap, failed, reason };
      console.warn("EPUB image upload failed, skipping", path, error);
      failed.push(path);
      reason = error?.message === "NOT_SIGNED_IN" ? "you're not signed in"
        : error?.message === "OFFLINE" ? "this device is offline"
        : String(error?.message || "upload failed");
      // Give up on the whole run only when sign-in itself is the problem —
      // missing, or rejected by storage's RLS policy. Every remaining upload
      // would fail identically, and without this a lost session means sitting
      // through hundreds of doomed uploads before being told none of them
      // worked. Deliberately NOT triggered by ordinary failures: a rate limit
      // or a single oversized file must not abandon the rest of the book's
      // figures.
      if (error?.message === "NOT_SIGNED_IN" || error?.authFailed) {
        for (let j = i + 1; j < imageEntries.length; j++) failed.push(imageEntries[j].path);
        break;
      }
    }
  }
  return { urlMap, failed, reason };
}

// Parses one spine entry's XHTML into a Document. Falls back to HTML
// parsing if the chapter isn't strict XHTML (common in loosely-authored
// EPUBs).
export async function epubParseChapterDoc(zip, spineEntry) {
  const entry = epubZipFile(zip, spineEntry.path, spineEntry.rawPath);
  if (!entry) return null;
  const html = await entry.async("text");
  const xmlDoc = new DOMParser().parseFromString(html, "application/xhtml+xml");
  return xmlDoc.querySelector("parsererror")
    ? new DOMParser().parseFromString(html, "text/html")
    : xmlDoc;
}

// Rewrites embedded image references within a container element (a whole
// chapter body, or a Range-extracted fragment of one — see
// extractEpubRangeMarkdown) to their uploaded hosted URLs (or drops the
// image if it wasn't uploaded), then runs it through the same
// htmlToMarkdown() used for pasted rich text.
export function epubContainerToMarkdown(container, doc, chapterPath, imageUrlMap) {
  const chapterDir = epubDirname(chapterPath);

  // An href already pointing outside the book (remote URL, data: URI) is
  // usable as-is and is kept untouched; an in-book one is swapped for its
  // uploaded URL, or dropped if the upload didn't happen (skipped, failed,
  // or upload rejected) since an in-zip path would render as a broken image.
  const hostedSrcFor = (href) => {
    if (!href) return null;
    if (isExternalEpubHref(href)) return href.trim();
    return imageUrlMap.get(resolveEpubPath(chapterDir, href)) || null;
  };

  container.querySelectorAll("img[src]").forEach((img) => {
    const src = hostedSrcFor(img.getAttribute("src"));
    if (src) img.setAttribute("src", src);
    else img.remove();
  });
  container.querySelectorAll("image").forEach((image) => {
    const src = hostedSrcFor(
      image.getAttributeNS("http://www.w3.org/1999/xlink", "href")
      || image.getAttribute("xlink:href")
      || image.getAttribute("href")
    );
    if (src) {
      const replacement = doc.createElement("img");
      replacement.setAttribute("src", src);
      image.replaceWith(replacement);
    } else {
      image.remove();
    }
  });

  // epubMode keeps citation/footnote <sup> markers (and <sub>) instead of
  // stripping them the way the web-paste path does — see htmlToMarkdown.
  return htmlToMarkdown(container.innerHTML, { epubMode: true }).trim();
}

// Maps every id in one parsed chapter document to its element, for resolving
// in-file TOC anchors (href="chapter.html#some-id"). Built by scanning once
// rather than doing a `[id="…"]` CSS lookup per anchor: ids come straight out
// of arbitrary book markup and one containing a quote or bracket would break
// selector syntax, and a single file here can carry dozens of anchors. First
// id wins, matching how a browser resolves a duplicated id.
export function buildEpubIdMap(doc) {
  const map = new Map();
  const all = doc.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    const id = all[i].getAttribute("id");
    if (id && !map.has(id)) map.set(id, all[i]);
  }
  return map;
}

// Extracts the Markdown for the slice of one chapter document's body that
// falls between two points — startNode inclusive (or the very start of the
// body when null) up to endNode exclusive (or the very end when null) —
// using Range.cloneContents(), which correctly reconstructs any ancestor
// element straddling the cut (e.g. a <div> that has to be "split" because
// only its second half belongs in this slice) rather than requiring the
// split points to land on clean element boundaries. This is what lets a
// single physical chapter file be divided at its own internal sub-heading
// anchors — see planEpubChapters / convertEpubChapters.
export function extractEpubRangeMarkdown(doc, body, startNode, endNode, chapterPath, imageUrlMap) {
  const range = doc.createRange();
  if (startNode) range.setStartBefore(startNode);
  else range.setStart(body, 0);
  if (endNode) range.setEndBefore(endNode);
  else range.setEnd(body, body.childNodes.length);
  if (range.collapsed) return "";
  const container = doc.createElement("div");
  container.appendChild(range.cloneContents());
  return epubContainerToMarkdown(container, doc, chapterPath, imageUrlMap);
}

// Turns the book's table of contents into an ordered list of chapter-start
// "markers" — { spineIndex, anchorId, title } — spanning the whole book.
// Two kinds of source, both from parseEpubToc's entries:
//  - a bare entry (anchorId "") names an entire spine file as one chapter;
//  - an anchored entry names a point *inside* a spine file that also holds
//    other content — e.g. one physical page with an unlabeled intro
//    paragraph followed by several named sub-headings, which is exactly
//    how this class of Calibre conversion lays a chapter out. Each such
//    anchor becomes its own chapter boundary rather than being ignored or
//    merged wholesale into whichever chapter the file's name suggests.
// If the very first marker doesn't already sit at the top of the very
// first spine file, a synthetic leading marker (title resolved later via
// heading fallback) is prepended to cover the front matter a book's TOC
// often doesn't bother naming (cover, half-title, etc). Falls back to one
// marker per spine file — title resolved per-file via heading fallback,
// the pre-TOC behavior — when the book has no usable TOC at all.
export function planEpubChapters(spine, tocEntries) {
  if (!tocEntries.length) {
    return spine.map((entry, i) => ({ spineIndex: i, anchorId: "", title: "" }));
  }
  const pathToIndex = new Map(spine.map((entry, i) => [entry.path, i]));
  const markers = [];
  tocEntries.forEach((e) => {
    const spineIndex = pathToIndex.get(e.path);
    if (spineIndex === undefined) return; // TOC points outside the spine (broken/foreign book) — ignore
    markers.push({ spineIndex, anchorId: e.anchorId, title: e.title });
  });
  markers.sort((a, b) => a.spineIndex - b.spineIndex); // stable: preserves TOC order within the same file
  if (!markers.length || markers[0].spineIndex !== 0 || markers[0].anchorId) {
    markers.unshift({ spineIndex: 0, anchorId: "", title: "" });
  }
  return markers;
}

// Fills in the title of every marker that doesn't already have one, in
// place, so the preview list and the decks the import actually creates are
// guaranteed to read from the same resolved titles rather than each running
// their own fallback (which previously disagreed: the preview named the
// leading front-matter chapter from its heading while the import, which had
// no fallback on that path, called the same deck "Chapter 1"). Markers
// sourced from the TOC already carry their real title; only a synthetic
// leading marker — or every marker, for a book with no TOC at all — needs
// the per-file heading/<title> fallback that costs a zip read.
export async function resolveEpubMarkerTitles(zip, spine, markers) {
  for (let i = 0; i < markers.length; i++) {
    if (markers[i].title) continue;
    try {
      const doc = await epubParseChapterDoc(zip, spine[markers[i].spineIndex]);
      const body = doc?.body || doc?.documentElement;
      const heading = body?.querySelector("h1, h2, h3, h4, h5, h6");
      markers[i].title = epubChapterRawTitle(heading?.textContent, doc?.title, "", i + 1);
    } catch (error) {
      markers[i].title = `Chapter ${i + 1}`;
    }
  }
  return markers;
}

// The numbered chapter-title lines shown in the preview modal, so the user
// sees the book's actual table of contents before committing to the import
// rather than just a chapter count. Titles come from resolveEpubMarkerTitles,
// the same ones the import itself will use.
export function buildEpubTocPreview(markers) {
  const padWidth = String(markers.length).length;
  return markers.map((m, i) => `${String(i + 1).padStart(padWidth, "0")}. ${m.title}`);
}

// ── EPUB content preview (local, before any upload) ───────────────────────
// The preview must show the exact notes the import will save WITHOUT uploading
// anything — so it reuses convertEpubChapters (the very converter the real
// import runs) but hands it this resolver in place of the hosted-URL image map.
// Every in-book image path that exists in the manifest resolves to an inert
// same-document fragment marker ("#epub-img=<zip path>") instead of a hosted
// URL: truthy, so epubContainerToMarkdown KEEPS the <img> exactly as the real
// import would (it drops only images whose lookup is falsy), and it fetches
// nothing. showEpubPreview swaps each marker for a real object URL lazily, only
// when its chapter is expanded (hydrateEpubPreviewImages), and revokes them all
// when the modal closes — so a preview the user cancels uploads and leaks
// nothing.
export const EPUB_PREVIEW_IMG_PREFIX = "epub-img=";

export function makeEpubPreviewImageResolver(imageEntries) {
  const paths = new Set(imageEntries.map((entry) => entry.path));
  return {
    get(path) {
      if (!paths.has(path)) return null;
      // encodeURIComponent leaves ()' unescaped, and a bare "(" or ")" in a
      // markdown image URL truncates the link — encode those too so the marker
      // survives the html→markdown→html round trip intact.
      const encoded = encodeURIComponent(path).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16));
      return `#${EPUB_PREVIEW_IMG_PREFIX}${encoded}`;
    }
  };
}

// Converts every chapter to Markdown locally for the preview — byte-identical
// to what the real import saves (same convertEpubChapters, same markers) except
// image srcs are the inert markers above rather than hosted URLs. No network,
// no image decode. Returns [{ title, markdown }], the same shape the import
// uses. progress is null: convertEpubChapters treats a missing progress as
// "no modal / never cancelled", so it runs to completion in the background.
export async function convertEpubChaptersForPreview(zip, spine, markers, imageEntries) {
  const resolver = makeEpubPreviewImageResolver(imageEntries);
  const chapters = await convertEpubChapters(zip, spine, markers, resolver, null);
  // A marker image with an EMPTY alt renders as "![](#epub-img=…)", whose
  // "[](#…)" tail collides with the notes renderer's footnote-backref cleanup
  // (normalizeCitations strips "[<whitespace>](#…)") — it eats the image and
  // leaves a stray "!". Books that wrap art in <svg><image> (Kindle covers,
  // full-page illustrations) produce exactly these alt-less images. Give every
  // empty/whitespace-alt marker a non-empty alt so it survives the pipeline and
  // renders as a real image. Preview-only: the hosted import is unaffected.
  const emptyAltMarker = new RegExp(`!\\[\\s*\\]\\((#${EPUB_PREVIEW_IMG_PREFIX}[^)]*)\\)`, "g");
  return chapters.map((chapter) => ({
    ...chapter,
    markdown: (chapter.markdown || "").replace(emptyAltMarker, "![image]($1)")
  }));
}

// Renders one chapter's cached preview Markdown into `body` using the same
// pipeline the notes view uses (markdownToSafeHtml + enhanceRenderedMarkdown),
// then hydrates its inert image markers into real object URLs read straight
// from the zip. The markers are stripped of their src BEFORE enhancement so the
// browser never tries to fetch "#epub-img=…" as an image (which would flash a
// broken-image icon); the real src is set only once its blob is decoded.
// `cache` = { urls: Map(path -> objectURL), created: [objectURL] } is shared
// across the whole modal so an image shown in two chapters decodes once, and
// every created URL is tracked for revocation on close.
export async function renderEpubPreviewChapter(body, markdown, zip, cache) {
  body.innerHTML = markdownToSafeHtml(markdown || "");
  const pending = [];
  body.querySelectorAll(`img[src^="#${EPUB_PREVIEW_IMG_PREFIX}"]`).forEach((img) => {
    const marker = img.getAttribute("src").slice(1 + EPUB_PREVIEW_IMG_PREFIX.length);
    let path;
    try { path = decodeURIComponent(marker); } catch { path = marker; }
    img.removeAttribute("src");
    img.dataset.epubPreviewPath = path;
    pending.push(img);
  });
  await enhanceRenderedMarkdown(body);
  await hydrateEpubPreviewImages(pending, zip, cache);
}

export async function hydrateEpubPreviewImages(imgs, zip, cache) {
  for (const img of imgs) {
    const path = img.dataset.epubPreviewPath;
    if (!path) continue;
    if (cache.urls.has(path)) { img.src = cache.urls.get(path); continue; }
    try {
      const entry = zip.file(path);
      if (!entry) { img.remove(); continue; }
      const blob = await entry.async("blob");
      const url = URL.createObjectURL(blob);
      cache.urls.set(path, url);
      cache.created.push(url);
      img.src = url;
    } catch (error) {
      console.warn("EPUB preview image could not be shown", path, error);
      img.remove();
    }
  }
}

// Walks the spine once, cutting each file's body at whichever of its
// markers resolve to a real in-file anchor (Range-based — see
// extractEpubRangeMarkdown) and appending each slice's Markdown to whatever
// chapter is "current" at that point in the book. A file with no markers of
// its own is entirely a continuation of the chapter already running; a
// file's content before its own first anchor (when that anchor isn't at the
// very top) continues the chapter running from before this file, same as a
// markerless file would. Returns the final {title, markdown} decks, already
// numbered and with empty ones dropped.
export async function convertEpubChapters(zip, spine, markers, imageUrlMap, progress) {
  const markersByFile = new Map();
  markers.forEach((m) => {
    if (!markersByFile.has(m.spineIndex)) markersByFile.set(m.spineIndex, []);
    markersByFile.get(m.spineIndex).push(m);
  });

  const chapters = [];
  let current = null;
  const startChapter = (title) => {
    current = { title: title || `Chapter ${chapters.length + 1}`, parts: [] };
    chapters.push(current);
  };

  for (let spineIndex = 0; spineIndex < spine.length; spineIndex++) {
    // Counted in spine files, not chapters: one file can hold several
    // chapters (or half of one), so a "chapter i/N" label here would
    // contradict the chapter count the preview just showed.
    const label = `Converting page ${spineIndex + 1}/${spine.length}…`;
    setStatus(label);
    progress?.update(label, spineIndex / Math.max(spine.length, 1));
    await epubYield();
    if (progress?.cancelled()) break;
    const spineEntry = spine[spineIndex];
    let doc;
    try {
      doc = await epubParseChapterDoc(zip, spineEntry);
    } catch (error) {
      console.warn("EPUB chapter parse failed, skipping", spineEntry.path, error);
      continue;
    }
    const body = doc?.body || doc?.documentElement;
    if (!body) continue;

    const fileMarkers = markersByFile.get(spineIndex) || [];
    const positions = [];
    if (fileMarkers.length) {
      const idMap = fileMarkers.some((m) => m.anchorId) ? buildEpubIdMap(doc) : null;
      const seenNodes = new Set();
      fileMarkers.forEach((m) => {
        if (!m.anchorId) { positions.push({ marker: m, node: null }); return; }
        const node = idMap.get(m.anchorId);
        // Anchors that don't resolve to a real element inside this file's
        // body, and two anchors landing on the same element, are dropped
        // rather than allowed to cut the body at a nonsense point: either
        // would produce an empty or backwards Range below and silently eat
        // the text around it.
        if (!node || !body.contains(node) || seenNodes.has(node)) return;
        seenNodes.add(node);
        positions.push({ marker: m, node });
      });
      // A TOC's listed order isn't guaranteed to match the order its anchors
      // physically appear in the file. Cutting at points taken out of
      // document order would build backwards Ranges, which collapse to
      // nothing and drop that chapter's text, so sort by real document
      // position. The bare (whole-file) marker, if any, always leads.
      positions.sort((a, b) => {
        if (!a.node) return -1;
        if (!b.node) return 1;
        return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    }

    if (!positions.length) {
      // Nothing usable targets this file specifically: it's either a pure
      // continuation page, or (only possible for spine index 0) a book with
      // no TOC at all reaching its per-file fallback.
      const markdown = epubContainerToMarkdown(body, doc, spineEntry.path, imageUrlMap);
      if (markdown) {
        // No chapter is running yet only if every file before this one
        // failed to parse — the plan always puts a marker on spine index 0.
        if (!current) {
          const heading = body.querySelector("h1, h2, h3, h4, h5, h6");
          startChapter(epubChapterRawTitle(heading?.textContent, doc.title, "", chapters.length + 1));
        }
        current.parts.push(markdown);
      }
      continue;
    }

    try {
      if (positions[0].node) {
        const leading = extractEpubRangeMarkdown(doc, body, null, positions[0].node, spineEntry.path, imageUrlMap);
        if (leading && current) current.parts.push(leading);
      }
      for (let i = 0; i < positions.length; i++) {
        const startNode = positions[i].node;
        const endNode = positions[i + 1]?.node || null;
        startChapter(positions[i].marker.title);
        const segment = extractEpubRangeMarkdown(doc, body, startNode, endNode, spineEntry.path, imageUrlMap);
        if (segment) current.parts.push(segment);
      }
    } catch (error) {
      console.warn("EPUB chapter split failed for this file, its remaining content may be missing", spineEntry.path, error);
    }
  }

  // Chapters that produced nothing at all (an image-only cover page when
  // images were skipped, a bare divider heading) are dropped rather than
  // saved as blank decks — and the numbering is applied only after that, so
  // what lands in My Decks is always a gapless 01..N rather than starting at
  // "02" with a hole where the dropped chapter would have been.
  const kept = chapters.filter((c) => c.parts.length);
  const padWidth = String(kept.length).length;
  return kept.map((c, i) => ({
    title: `${String(i + 1).padStart(padWidth, "0")}. ${c.title}`,
    markdown: c.parts.join("\n\n")
  }));
}

// How many decks already sit in the folder this book would import into.
// Importing always creates fresh decks, so a second import of the same book
// silently doubles every chapter — worth warning about before it happens.
export function epubTargetFolderDeckCount(bookTitle) {
  const sanitized = bookTitle.replace(/\//g, "-").trim() || "Imported Book";
  const parent = currentMyDecksFolder();
  const folderPath = normalizeDeckCategory(parent ? `${parent}${FOLDER_SEP}${sanitized}` : sanitized);
  return decksUnderFolder(folderPath).length;
}

// Analysis panel shown right after a fast, network-free parse of the EPUB's
// container.xml + package document — before any image upload or chapter
// conversion starts, so the user sees book title/author/counts almost
// instantly instead of a silent wait. Resolves { mode: "chapters" | "book" }
// (Import) or null (Cancel).
export function showEpubPreview({ title, author, chapterCount, imageCount, existingDeckCount = 0, chaptersPromise, previewChaptersPromise, zip }) {
  return new Promise((resolve) => {
    const modal = document.createElement("section");
    modal.className = "category-choice-modal epub-preview-modal";
    modal.setAttribute("aria-label", "Import EPUB");

    const shell = document.createElement("div");
    shell.className = "category-choice-shell epub-preview-shell";
    shell.innerHTML = `
      <div class="category-choice-head">
        <div>
          <h2 class="epub-preview-title"></h2>
          <p class="epub-preview-author"></p>
        </div>
        <button type="button" data-epub-cancel aria-label="Close">&#215;</button>
      </div>
      <div class="epub-preview-stats">
        <div class="epub-preview-stat"><strong class="epub-preview-chapters"></strong><span>Chapters</span></div>
        <div class="epub-preview-stat"><strong class="epub-preview-images"></strong><span>Images</span></div>
      </div>
      <div class="epub-preview-mode" role="radiogroup" aria-label="Import as">
        <label class="epub-preview-mode-option">
          <input type="radio" name="epub-import-mode" value="chapters" checked>
          <span>
            <strong>Separate deck per chapter</strong>
            <small>One deck per chapter (notes only), inside a new folder named after the book.</small>
          </span>
        </label>
        <label class="epub-preview-mode-option">
          <input type="radio" name="epub-import-mode" value="book">
          <span>
            <strong>Single deck for the whole book</strong>
            <small>All chapters combined into one deck's notes, with chapter titles kept as headings.</small>
          </span>
        </label>
      </div>
      <div class="epub-preview-toc">
        <p class="epub-preview-toc-label">Chapter preview — tap a chapter to read the note</p>
        <p class="epub-preview-toc-loading">Reading chapter titles…</p>
        <ol class="epub-preview-toc-list" hidden></ol>
      </div>
      <p class="restore-note epub-preview-warning" hidden></p>
      <div class="category-choice-actions">
        <button type="button" data-epub-cancel>Cancel</button>
        <button type="button" class="import-action-primary" data-epub-confirm>Import</button>
      </div>
    `;

    // Set via textContent (never innerHTML) so book metadata can't inject markup.
    shell.querySelector(".epub-preview-title").textContent = title || "Untitled book";
    shell.querySelector(".epub-preview-author").textContent = author ? `by ${author}` : "";
    shell.querySelector(".epub-preview-chapters").textContent = String(chapterCount);
    shell.querySelector(".epub-preview-images").textContent = String(imageCount);

    // Every object URL created to show a preview image is tracked here and
    // revoked in cleanup(), so nothing is committed to the notes and no
    // blob: handle leaks whether the user confirms or cancels.
    const cache = { urls: new Map(), created: [] };
    const tocLoading = shell.querySelector(".epub-preview-toc-loading");
    const tocList = shell.querySelector(".epub-preview-toc-list");

    // Fast pass: the plain chapter-title list needs only a light local walk
    // over the zip, so it streams in first (behind a loading line) to give
    // the modal visible structure. These rows are replaced in place by the
    // expandable content rows below as soon as the real conversion lands.
    if (chaptersPromise) {
      chaptersPromise.then((lines) => {
        if (!modal.isConnected || tocList.childElementCount) return;
        if (!lines.length) {
          if (tocLoading) tocLoading.textContent = "No table of contents found.";
          return;
        }
        if (tocLoading) tocLoading.textContent = "Rendering preview…";
        tocList.hidden = false;
        lines.forEach((line) => {
          const li = document.createElement("li");
          li.className = "epub-preview-toc-item";
          li.title = line;
          li.textContent = line;
          tocList.appendChild(li);
        });
      }).catch(() => {
        if (tocLoading && !tocList.childElementCount) tocLoading.textContent = "Could not read chapter titles.";
      });
    }

    // Authoritative pass: the real converted chapters (same keep/drop as the
    // actual import). Rebuild the list as expandable rows whose bodies render
    // the true note — images included — lazily on first expand. Nothing here
    // touches the network; images are decoded from the local zip on demand.
    const buildPreviewChapterRow = (chapter, index) => {
      const li = document.createElement("li");
      li.className = "epub-preview-chapter";

      const header = document.createElement("button");
      header.type = "button";
      header.className = "epub-preview-chapter-toggle";
      header.setAttribute("aria-expanded", "false");

      const name = document.createElement("span");
      name.className = "epub-preview-chapter-name";
      name.textContent = chapter.title || `Chapter ${index + 1}`;
      name.title = name.textContent;

      const chevron = document.createElement("span");
      chevron.className = "epub-preview-chapter-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "▸";

      header.append(name, chevron);

      const body = document.createElement("div");
      body.className = "epub-preview-chapter-body";
      body.hidden = true;

      let rendered = false;
      header.addEventListener("click", async () => {
        const open = header.getAttribute("aria-expanded") === "true";
        if (open) {
          header.setAttribute("aria-expanded", "false");
          body.hidden = true;
          return;
        }
        header.setAttribute("aria-expanded", "true");
        body.hidden = false;
        if (rendered) return;
        rendered = true;
        body.innerHTML = '<p class="epub-preview-chapter-loading">Rendering…</p>';
        try {
          await renderEpubPreviewChapter(body, chapter.markdown, zip, cache);
        } catch (error) {
          console.warn("EPUB preview chapter render failed", error);
          rendered = false;
          body.innerHTML = '<p class="epub-preview-chapter-loading">Could not render this chapter.</p>';
        }
      });

      li.append(header, body);
      return li;
    };

    if (previewChaptersPromise) {
      previewChaptersPromise.then((chapters) => {
        if (!modal.isConnected) return;
        if (!chapters || !chapters.length) {
          if (tocLoading) tocLoading.textContent = "No previewable content found.";
          tocList.hidden = true;
          tocList.replaceChildren();
          return;
        }
        tocLoading?.remove();
        tocList.hidden = false;
        tocList.replaceChildren();
        chapters.forEach((chapter, index) => {
          tocList.appendChild(buildPreviewChapterRow(chapter, index));
        });
      }).catch((error) => {
        console.warn("EPUB content preview failed", error);
        if (tocLoading) tocLoading.textContent = "Could not render chapter preview.";
      });
    }

    // The "folder already holds N decks" warning only applies to the
    // per-chapter mode (the whole-book mode saves one deck, no folder), so
    // it toggles with the mode choice rather than being fixed at open time.
    const warning = shell.querySelector(".epub-preview-warning");
    const modeInputs = shell.querySelectorAll('input[name="epub-import-mode"]');
    const selectedMode = () => shell.querySelector('input[name="epub-import-mode"]:checked')?.value || "chapters";
    const updateWarningVisibility = () => {
      warning.hidden = !(selectedMode() === "chapters" && existingDeckCount > 0);
    };
    if (existingDeckCount > 0) {
      warning.textContent = `⚠ That folder already holds ${existingDeckCount} deck${existingDeckCount === 1 ? "" : "s"} — importing again adds a second copy of every chapter rather than replacing them.`;
    }
    modeInputs.forEach((input) => input.addEventListener("change", updateWarningVisibility));
    updateWarningVisibility();

    const cleanup = (value) => {
      // Revoke every preview blob URL so nothing leaks once the modal closes
      // (cancel or hand-off to import). The real import re-fetches/re-uploads
      // from the zip, so these preview-only URLs are never referenced again.
      cache.created.forEach((url) => {
        try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
      });
      cache.created.length = 0;
      cache.urls.clear();
      modal.remove();
      resolve(value);
    };
    shell.querySelectorAll("[data-epub-cancel]").forEach((button) => {
      button.addEventListener("click", () => cleanup(null));
    });
    shell.querySelector("[data-epub-confirm]")?.addEventListener("click", () => cleanup({ mode: selectedMode() }));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) cleanup(null);
    });

    modal.appendChild(shell);
    document.body.appendChild(modal);
    shell.querySelector("[data-epub-confirm]")?.focus();
  });
}

// Live progress modal shown once the import actually starts (image uploads +
// chapter conversion + deck creation) — replaces the earlier silent wait
// (status-bar text alone, easy to miss behind the My Decks panel) with
// continuous visible feedback so the import never looks frozen.
export function showEpubProgress(title) {
  const modal = document.createElement("section");
  modal.className = "category-choice-modal epub-progress-modal";
  modal.setAttribute("aria-label", "Importing EPUB");

  const shell = document.createElement("div");
  shell.className = "category-choice-shell epub-progress-shell";
  shell.innerHTML = `
    <div class="category-choice-head">
      <div>
        <h2 class="epub-progress-title"></h2>
        <p class="epub-progress-line">Starting…</p>
      </div>
    </div>
    <div class="job-progress-track"><div class="job-progress-fill"></div></div>
    <div class="category-choice-actions">
      <button type="button" data-epub-stop>Cancel</button>
    </div>
  `;
  shell.querySelector(".epub-progress-title").textContent = `Importing “${title}”`;

  modal.appendChild(shell);
  document.body.appendChild(modal);

  const line = shell.querySelector(".epub-progress-line");
  const fill = shell.querySelector(".job-progress-fill");
  const stopBtn = shell.querySelector("[data-epub-stop]");
  // A big illustrated book is minutes of uploads; without this the user is
  // stuck watching it. The loops poll cancelled() between steps and stop at
  // the next boundary, keeping whatever chapters were already saved.
  let cancelled = false;
  stopBtn?.addEventListener("click", () => {
    cancelled = true;
    stopBtn.disabled = true;
    if (line) line.textContent = "Finishing the current step…";
  });

  return {
    update(text, fraction) {
      if (line && !cancelled) line.textContent = text;
      if (fill && typeof fraction === "number") fill.style.width = `${Math.min(100, Math.round(fraction * 100))}%`;
    },
    cancelled() { return cancelled; },
    close() { modal.remove(); }
  };
}

// Uploads images, converts every spine chapter, then saves one deck per
// chapter into a new folder named after the book.
export async function runEpubImport(zip, pkg, bookTitle, imageEntries, markers, mode = "chapters", folderPath = null) {
  const progress = showEpubProgress(bookTitle);
  // Hoisted out of the try so the catch below can put the user's own working
  // deck back even if the import blows up partway through the save loop.
  let savedState = null;
  try {
    // One bucket folder per import RUN, not per book title: importing the same
    // book twice must not have the second run's figures overwrite or interleave
    // with the first's, and abandoning a bad import has to be one folder to
    // delete. storageGroupId is what makes each run distinct.
    const imageFolder = `books/${storageFolderSlug(bookTitle, "book")}--${storageGroupId()}`;
    const { urlMap: imageUrlMap, failed: failedImages, reason: imageFailReason } =
      await uploadEpubImages(zip, imageEntries, progress, imageFolder);
    const chapters = await convertEpubChapters(zip, pkg.spine, markers, imageUrlMap, progress);

    if (!chapters.length) {
      const message = progress.cancelled()
        ? "EPUB import cancelled."
        : "Could not extract any chapter content from this EPUB.";
      setStatus(message, progress.cancelled() ? undefined : "error");
      showToast(message, progress.cancelled() ? "info" : "error");
      return;
    }

    // Chapter decks are written directly via saveDeckToLibrary rather than the
    // single-deck-at-a-time editor flow (createNewDeck etc.) — save/restore the
    // in-memory working deck around the save(s) so this doesn't clobber
    // whatever deck the user had open before starting the import.
    savedState = {
      deckId: state.deckId, localDeckId: state.localDeckId, deckTitle: state.deckTitle,
      deckCategory: state.deckCategory, notes: state.notes, masterCards: state.masterCards,
      sourceTitle: state.sourceTitle
    };

    const sanitizedTitle = bookTitle.replace(/\//g, "-").trim() || "Imported Book";
    // An explicit target (a folder's own "Import here" button) wins; otherwise
    // the book lands where My Decks is currently looking, as it always has.
    // NOTE: deliberately NOT named folderPath. A `let folderPath` here is
    // block-scoped to this try, so it shadows the parameter for the whole
    // block — and the parentFolder line above then reads it before its
    // declaration, throwing a TDZ ReferenceError on every single import
    // (after the images had already been uploaded, so the book's figures
    // landed in the bucket and no deck was ever written).
    const parentFolder = folderPath != null ? folderPath : currentMyDecksFolder();
    let targetFolder;
    let saved = 0;
    let saveFailed = false;

    if (mode === "book") {
      // Whole-book mode: one deck, no book-named folder — each chapter's
      // title survives as a "##" heading inside the single note, so the
      // existing in-note table of contents still gives chapter-by-chapter
      // navigation without creating a deck per chapter.
      targetFolder = parentFolder;
      const combinedMarkdown = chapters.map((c) => `## ${c.title}\n\n${c.markdown}`).join("\n\n---\n\n");
      setStatus(`Saving "${bookTitle}"…`);
      progress.update(`Saving "${bookTitle}"…`, 0.9);
      state.deckId = null;
      state.localDeckId = null;
      state.deckTitle = sanitizedTitle;
      state.deckCategory = targetFolder;
      state.notes = combinedMarkdown;
      state.masterCards = [];
      state.sourceTitle = sanitizedTitle;
      // Brand new deck — don't inherit whatever meta was in state before this import.
      state.meta = {};
      if (await saveDeckToLibrary({ silent: true })) saved = 1;
      else saveFailed = true;
    } else {
      targetFolder = normalizeDeckCategory(parentFolder ? `${parentFolder}${FOLDER_SEP}${sanitizedTitle}` : sanitizedTitle);
      addKnownFolder(targetFolder);

      // My Decks defaults to sorting by recency descending (deckAccessTime) —
      // so chapter 1 gets the newest updatedAt/createdAt and each later
      // chapter a second older, which is what puts them back in reading
      // order on screen under the default sort (and under "Last updated" /
      // "Date created", which derive from the same stagger). A user who's
      // switched to title or size sort will see chapters in that order
      // instead — an accepted tradeoff of sort being user-selectable now.
      const baseTime = Date.now();
      for (let i = 0; i < chapters.length; i++) {
        const label = `Creating chapter decks ${i + 1}/${chapters.length}…`;
        setStatus(label);
        progress.update(label, i / Math.max(chapters.length, 1));
        await epubYield();
        if (progress.cancelled()) break;
        state.deckId = null;
        state.localDeckId = null;
        state.deckTitle = chapters[i].title;
        state.deckCategory = targetFolder;
        state.notes = chapters[i].markdown;
        state.masterCards = [];
        state.sourceTitle = chapters[i].title;
        // Each chapter deck is brand new — don't inherit meta from the
        // previous chapter's iteration or the deck open before this import.
        state.meta = {};
        // A book is many decks in one go, so this is the realistic way to hit
        // the storage quota. saveDeckToLibrary returns null (never throws) on
        // failure — ignoring that would leave a half-imported book behind a
        // "Done" toast.
        if (!(await saveDeckToLibrary({ silent: true, updatedAt: new Date(baseTime - i * 1000).toISOString() }))) {
          saveFailed = true;
          break;
        }
        saved += 1;
      }
    }

    Object.assign(state, savedState);
    persistWorkingDeck();

    setMyDecksView("folder");
    setMyDecksCwd(targetFolder);
    // renderMyDecksList, NOT repaintMyDecks: repaint redraws from the cached
    // deck set captured before this import, so the new book folder would render
    // from the known-folder registry alone — visible but claiming "0 decks",
    // with nothing for a folder selection to act on. Every other path that
    // changes deck data re-reads the same way.
    if (el.myDecksPanel && !el.myDecksPanel.hidden) renderMyDecksList();
    else openMyDecksPanel();

    if (saveFailed) {
      const message = mode === "book"
        ? (lastSaveErrorWasQuota ? "Could not save — device storage is full." : "Could not save this deck.")
        : lastSaveErrorWasQuota
          ? `Only ${saved} of ${chapters.length} chapters saved — device storage is full. Delete some decks and re-import.`
          : `Only ${saved} of ${chapters.length} chapters could be saved.`;
      progress.update(message, saved / Math.max(mode === "book" ? 1 : chapters.length, 1));
      setStatus(message, "error");
      showToast(message, "error");
      return;
    }

    const chapterWord = `chapter${saved === 1 ? "" : "s"}`;
    const bookChapterWord = `chapter${chapters.length === 1 ? "" : "s"}`;
    const summary = mode === "book"
      ? (progress.cancelled()
          ? `Import stopped — saved "${bookTitle}" with ${chapters.length} ${bookChapterWord} converted so far`
          : `Imported "${bookTitle}" as one deck (${chapters.length} ${bookChapterWord})`)
      : progress.cancelled()
        ? `Import stopped — kept ${saved} ${chapterWord} of "${bookTitle}"`
        : `Imported "${bookTitle}" — ${saved} ${chapterWord}`;
    progress.update(summary, 1);
    setStatus(`${summary}.`);
    // An image that never made it into the notes is silent data loss — the
    // book still imports and the toast would otherwise claim a clean run,
    // leaving the reader to find the holes themselves. Said out loud, with
    // the cause, since "0 of 218 images" is only actionable once you know why.
    const imageNote = failedImages.length
      ? `${failedImages.length} of ${imageEntries.length} image${failedImages.length === 1 ? "" : "s"} could not be uploaded${imageFailReason ? ` (${imageFailReason})` : ""} and are missing from the notes.`
      : "";
    if (imageNote) {
      setStatus(`${summary}. ${imageNote}`, "error");
      showToast(`${summary} — ${imageNote}`, "error");
    } else {
      showToast(summary, progress.cancelled() ? "info" : undefined);
    }
  } catch (error) {
    // Without this, any bug in here left the images sitting in the bucket, the
    // progress modal closing on its own, and NO deck and NO explanation — the
    // only visible error was whatever unrelated toast happened to fire next
    // (typically the autosave's "device storage full"), which sent debugging
    // in exactly the wrong direction. Always name the real cause.
    console.error("EPUB import failed", error);
    if (savedState) {
      Object.assign(state, savedState);
      persistWorkingDeck();
    }
    const message = `Could not import "${bookTitle}" — ${error?.message || error?.name || "unexpected error"}`;
    setStatus(message, "error");
    showToast(message, "error");
  } finally {
    progress.close();
  }
}

// Both entry points below call importEpubFile without awaiting it, so anything
// that throws outside runEpubImport's own catch (the TOC/plan/preview stage)
// would otherwise become a console-only unhandled rejection with nothing on
// screen. Every EPUB failure must say so out loud.
export function reportEpubImportCrash(error) {
  console.error("EPUB import failed", error);
  const message = `Could not import this EPUB — ${error?.message || error?.name || "unexpected error"}`;
  setStatus(message, "error");
  showToast(message, "error");
}

// Entry point wired to the "Import EPUB" button's file input.
export async function importEpubFile(file, folderPath = null) {
  if (!file) return;
  if (!(await ensureJsZip())) {
    setStatus("Zip support did not load — cannot read EPUB files.", "error");
    return;
  }

  setStatus(`Reading ${file.name}…`);
  let zip, pkg;
  try {
    zip = await JSZip.loadAsync(file);
    const opf = await parseEpubContainer(zip);
    pkg = await parseEpubPackage(zip, opf);
  } catch (error) {
    console.error("EPUB parse failed", error);
    setStatus("Could not read this EPUB.", "error");
    showToast("Could not read this EPUB", "error");
    return;
  }

  if (!pkg.spine.length) {
    setStatus("This EPUB has no readable chapters.", "error");
    showToast("This EPUB has no readable chapters", "error");
    return;
  }

  const bookTitle = pkg.title || file.name.replace(/\.epub$/i, "");
  const imageEntries = Array.from(pkg.manifest.values()).filter((entry) => entry.mediaType.startsWith("image/"));

  // Computed once up front and reused by both the preview and the real
  // import. markers — not the raw spine — is the real source of truth for
  // "how many decks will this book become": see planEpubChapters for why a
  // spine file and a resulting chapter deck aren't always one-to-one.
  // Resolving the titles can need a zip read per marker, so it stays off the
  // modal's critical path behind a loading line and the stat tiles still
  // appear as fast as before.
  const tocEntries = await parseEpubToc(zip, pkg);
  const markers = planEpubChapters(pkg.spine, tocEntries);
  const titlesPromise = resolveEpubMarkerTitles(zip, pkg.spine, markers);
  const tocPreviewPromise = titlesPromise.then(buildEpubTocPreview);
  // The full per-chapter note content, converted locally (no upload) so the
  // user can read the actual notes before committing. Chained after the titles
  // resolve so each converted chapter carries its real name, and kept off the
  // modal's critical path — the stat tiles/TOC still show instantly while this
  // renders in the background behind a "Rendering preview…" line.
  const previewChaptersPromise = titlesPromise
    .then(() => convertEpubChaptersForPreview(zip, pkg.spine, markers, imageEntries));

  const choice = await showEpubPreview({
    title: bookTitle,
    author: pkg.author,
    chapterCount: markers.length,
    imageCount: imageEntries.length,
    existingDeckCount: epubTargetFolderDeckCount(bookTitle),
    chaptersPromise: tocPreviewPromise,
    previewChaptersPromise,
    zip
  });
  if (!choice) {
    setStatus("EPUB import cancelled.");
    return;
  }
  const mode = choice.mode === "book" ? "book" : "chapters";

  // resolveEpubMarkerTitles fills the markers in place, and Import is
  // clickable before it finishes — so settle it here or a fast click would
  // hand runEpubImport half-untitled markers and name those decks
  // "Chapter N". Already-resolved by now in every practical case; a failure
  // is non-fatal (the titles it couldn't read just keep their fallbacks).
  await tocPreviewPromise.catch(() => {});

  await runEpubImport(zip, pkg, bookTitle, imageEntries, markers, mode, folderPath);
}
