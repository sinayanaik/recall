// Resizing and deleting an image or diagram in place.
//
// The handle drags on the rendered element, but the width is committed back
// into the markdown slice it came from — so the size survives a re-render, an
// export and a sync.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { escapeHtml } from "../core/text.js?v=__BUILD__";
import { renderTargetConfig } from "../format/render-toolbar.js?v=__BUILD__";
import { isBrokenImage } from "./broken.js?v=__BUILD__";
import { deleteSupabaseImage } from "./upload.js?v=__BUILD__";
import { CANONICAL_SRC_ATTR } from "../cloud/storage-urls.js?v=__BUILD__";
import { LOCAL_IMAGE_SCHEME } from "./outbox.js?v=__BUILD__";
import { scopedQueryAll } from "../render/deferred-work.js?v=__BUILD__";
// block-cache imports this module back; both edges are function declarations
// called at runtime, which is the case the TDZ rule in tools/module-symbols.mjs
// allows. Nothing here reads it at module scope.
import { notesLazyBuiltImages } from "../render/block-cache.js?v=__BUILD__";
import { IMG_ALT_SOURCE, IMG_DEST_SOURCE, IMG_TOKEN_SOURCE, imageDestinationUrl } from "../render/inline.js?v=__BUILD__";
import { DIAGRAM_WIDTH_MAX, DIAGRAM_WIDTH_MIN, fenceInfoWithWidth, normalizeImageUrl, parseDiagramWidth, scanCodeRegions, scanFences } from "../render/preprocess.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showToast } from "../ui/feedback.js?v=__BUILD__";

// ── Which surfaces carry editable images ───────────────────────────────────
// The resize/delete grips started out as a notes-only feature, reading and
// rewriting state.notes directly. A card face is the same problem with a
// different backing string, so everything below takes an "image surface"
// instead: the render target (renderTargetConfig already knows how to read,
// write and re-render each one) plus the element the width badge measures its
// percentage against. One implementation, three surfaces — notes, question,
// answer — so an image pasted into a card is resized and deleted exactly the
// way one pasted into the notes is.
export const IMAGE_SURFACE_NAMES = ["notes", "question", "answer"];

export function imageSurfaceFor(name) {
  const target = renderTargetConfig(name);
  if (!target.view) return null;
  return { name, ...target };
}

// The surface that owns a rendered container, or null if it isn't one of the
// three (the All Cards list, a print root, the paste preview, …) — those render
// read-only and get no grips.
export function imageSurfaceForView(view) {
  if (!view) return null;
  const name = IMAGE_SURFACE_NAMES.find((n) => renderTargetConfig(n).view === view);
  return name ? imageSurfaceFor(name) : null;
}

// ── An image is a slice of the source, not a token index ───────────────────
//
// Every control below identifies the image it acts on by WHERE ITS MARKDOWN
// SITS — the exact `![](…)` / `<img …>` slice, found by scanning the source —
// rather than by the index of the top-level marked token that happened to
// contain it. Three things came out of the old token-index scheme, and all
// three were the same mistake:
//
//   • the classifier only understood a handful of token shapes, so an image in
//     a TABLE CELL (marked keeps cells in .header/.rows, which nothing walked),
//     one wrapped in a link inside running text, or one inside a
//     `<div align=center>…</div>` block rendered with no grip at all;
//   • pairing rendered images to tokens by position meant the pass could not
//     run until the WHOLE note was in the DOM — so on any note over
//     NOTES_LAZY_MIN_CHARS (i.e. every imported book) no image had a grip
//     until the reader had scrolled the book end to end;
//   • committing a width re-emitted the ENTIRE note from its token array to
//     change one number, which on a 2.6MB book is a full-string rebuild, a
//     re-normalisation of every blank line in it, and a whole-note sync push.
//
// A source scan has none of that: it finds every image whatever encloses it,
// it needs no DOM at all, and a commit splices one slice.
//
// The scan is a single regex pass (against marked.lexer's 125ms on that same
// 2.6MB note), it skips fenced code by walking the shared scanFences() the
// renderer walks, and it is cached on the source string — so the common case,
// a repeat render of an unchanged note, costs one string compare.

// The width a resize may commit. Freestyle within a sanity floor/ceiling: an
// image can be shrunk to a small accent or blown up past its container (the
// shell scrolls).
export const IMAGE_RESIZE_MIN_PX = 20;

export const IMAGE_RESIZE_MAX_PX = 2000;

// Entities that escapeHtml (which imgTagHtml writes through) can put in a URL
// or alt text, undone. The DOM decodes these for free — this parser cannot use
// the DOM, because it has to run in Node for tools/image-controls-check.mjs,
// and because a `src` read back through an element is the SIGNED url on a
// signed-in device rather than the one the markdown holds.
export function decodeMarkupEntities(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// `src`, `alt` and any committed width off a raw <img> tag. Pure string work
// (see decodeMarkupEntities); returns null for a tag with no src, which is not
// an image this can act on.
export function parseImgTagAttrs(raw) {
  const tag = String(raw || "");
  const src = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!src) return null;
  const alt = tag.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const width = tag.match(/--notes-img-w\s*:\s*(\d+)\s*px/i);
  return {
    url: decodeMarkupEntities(src[1] ?? src[2] ?? src[3] ?? "").trim(),
    alt: decodeMarkupEntities(alt ? (alt[1] ?? alt[2] ?? alt[3] ?? "") : ""),
    widthPx: width ? parseInt(width[1], 10) || null : null
  };
}

// `![alt](url "title")` → its parts. The title is dropped: a resize replaces
// the whole slice with a raw <img>, which has nowhere to carry one — the same
// trade the token-based commit made before it.
export function parseMarkdownImage(raw) {
  const match = String(raw || "").match(new RegExp(`^!(${IMG_ALT_SOURCE})(${IMG_DEST_SOURCE})$`));
  if (!match) return null;
  return { url: imageDestinationUrl(match[2].slice(1, -1)), alt: match[1].slice(1, -1), widthPx: null };
}

// `![alt][label]` (and the collapsed `![alt][]`), resolved through the note's
// own link-reference definitions. Nothing in the app WRITES this form — every
// upload path emits an inline `![](url)` — but a hand-written or imported note
// can hold one, and marked renders it as an image like any other, so a control
// that could not find it would be a picture on screen with no grip.
export const IMAGE_REF_DEFINITION_RE = "^ {0,3}\\[([^\\]\\n]+)\\]:[ \\t]*(\\S+)";

export function imageRefDefinitions(text) {
  const found = new Map();
  if (!text.includes("]:")) return found;
  const pattern = new RegExp(IMAGE_REF_DEFINITION_RE, "gm");
  let match;
  while ((match = pattern.exec(text))) {
    const label = match[1].trim().toLowerCase();
    // First definition wins, which is what CommonMark says too.
    if (!found.has(label)) found.set(label, match[2].replace(/^<|>$/g, ""));
  }
  return found;
}

export function parseReferenceImage(raw, definitions) {
  const match = String(raw || "").match(new RegExp(`^!(${IMG_ALT_SOURCE})\\[([^\\]]*)\\]$`));
  if (!match) return null;
  const alt = match[1].slice(1, -1);
  const url = definitions.get((match[2].trim() || alt.trim()).toLowerCase());
  return url ? { url, alt, widthPx: null } : null;
}

// The three forms one image can be written in. IMG_TOKEN_SOURCE (markdown
// `![](…)` or a raw <img> tag) is the renderer's own pattern — shared so what
// the controls act on and what renderImageRows lays out cannot drift — plus
// the reference form above. Ordered: the inline branches match first, so
// `![a](b)` is never read as a reference.
//
// A function, not a const, for the same reason fenceOpenPattern() is one: a `g`
// regex carries its own lastIndex, so each scan needs its own — and building
// it at call time keeps this module free of a top-level read across an import
// cycle (see the TDZ rule in tools/module-symbols.mjs).
export function sourceImagePattern() {
  return new RegExp(`${IMG_TOKEN_SOURCE}|!${IMG_ALT_SOURCE}\\[[^\\]]*\\]`, "gi");
}

// Is the character at `offset` escaped? `\![alt](url)` is a literal "!" in front
// of a link to marked, not a picture, and a control offered over one would
// rewrite text that renders as itself. An EVEN number of backslashes in front is
// escaped backslashes and leaves the character itself live.
export function isEscapedOffset(text, offset) {
  let slashes = 0;
  while (offset - slashes - 1 >= 0 && text[offset - slashes - 1] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

// Every image in a note's SOURCE, in document order, as
// { start, end, raw, url, alt, widthPx }.
//
// Code is skipped — an `![](…)` the reader sees as TEXT is not a picture, and
// treating it as one would let a control rewrite something that never rendered.
// scanCodeRegions is the authority on where that text is (fences, indented
// blocks, blockquoted and list-indented fences, HTML comments, verbatim HTML
// blocks); a tightly backticked image is the same thing written inline and is
// skipped here, as is one whose "!" has been escaped. (A code span written with
// a doubled or spaced delimiter is still found; nothing renders for it, so no
// shell ever matches it, and the only cost is that a real image sharing that URL
// is treated as having a duplicate.)
// `skipCode` — off only for the recovery pass in sourceImageFor, which is asking
// a different question: not "what will the reader see as a picture" but "where
// on earth is the picture they are ALREADY looking at". A shell on screen is
// marked's own answer that this image is not code, so a scan that disagrees is
// the thing that is wrong, and looking again without the filter is how the
// disagreement gets resolved. Nothing else may pass false here.
export function findSourceImages(source, { skipCode = true } = {}) {
  const text = String(source || "");
  if (!sourceMayHaveImages(text)) return [];
  const definitions = imageRefDefinitions(text);
  const found = [];
  const scanGap = (from, to) => {
    if (to <= from) return;
    const gap = text.slice(from, to);
    const images = sourceImagePattern();
    let hit;
    while ((hit = images.exec(gap))) {
      const raw = hit[0];
      const start = from + hit.index;
      const end = start + raw.length;
      if (text[start - 1] === "`" && text[end] === "`") continue;
      if (isEscapedOffset(text, start)) continue;
      const info = raw.startsWith("<") ? parseImgTagAttrs(raw)
        : raw.includes("](") ? parseMarkdownImage(raw)
        : parseReferenceImage(raw, definitions);
      if (!info || !info.url) continue;
      found.push({ start, end, raw, ...info });
    }
  };
  let at = 0;
  // scanCodeRegions, not scanFences: a fence is only part of what the renderer
  // reads as code or as raw HTML, and an image the reader never sees is not an
  // image a control may act on. See the header on scanCodeRegions.
  if (skipCode) {
    for (const region of scanCodeRegions(text)) {
      scanGap(at, region.start);
      at = Math.max(at, region.end);
    }
  }
  scanGap(at, text.length);
  return found;
}

// One entry, not a map, for the same reason the lex cache it replaces held one:
// the three surfaces are scanned in turn but a reader only ever edits one, and
// a scan per surface would keep two notes' worth of results alive for nothing.
export let lastSourceImageScanSource = null;

export let lastSourceImageScanResult = null;

export function surfaceSourceImages(surface) {
  const source = surface?.getSource?.() || "";
  if (lastSourceImageScanResult && lastSourceImageScanSource === source) return lastSourceImageScanResult;
  const images = findSourceImages(source);
  lastSourceImageScanSource = source;
  lastSourceImageScanResult = images;
  return images;
}

// There is deliberately no invalidate() to call: the cache key IS the source
// string, so a note that has been rewritten simply misses and is re-scanned.

// Could this note contain an image at all? A regex over the source is single
// digit milliseconds where the lexer is over a hundred, and a note with no
// images has nothing for enhanceSurfaceImageControls to attach anyway. Covers
// both markdown images and the raw <img> tags a resize writes back.
export function sourceMayHaveImages(source) {
  return /!\[|<img\b/i.test(source || "");
}

// Same idea for diagrams: findDiagramFences walks every fence in the note, and
// a note with no mermaid/nomnoml fence cannot have a diagram to attach a grip
// to. (The fence walk is the expensive half — the DOM query below it is not.)
export function sourceMayHaveDiagrams(source) {
  return /mermaid|nomnoml/i.test(source || "");
}

// The URL this rendered image is written as IN THE MARKDOWN, which is not
// necessarily its `src`. Two passes rewrite src between the render and here,
// both of them deliberately (see block-cache.js's render tail):
//
//   • resolveStorageImages swaps the canonical Supabase URL the note holds for
//     a short-lived signed one, keeping the original in data-canonical-src;
//   • hydrateLocalImages swaps a `recall-img:<token>` placeholder for the
//     blob: URL its bytes are sitting at, keeping the token in dataset.
//
// enhanceSurfaceImageControls pairs shells with tokens by URL, so reading
// `src` there meant that on any signed-in device every image mismatched and
// lost its grip — and, because the walk did not advance past a mismatch, so did
// every image after it. This is the URL that matching has to use.
export function sourceUrlForImage(img) {
  if (!img) return "";
  const token = img.dataset?.localToken;
  if (token) return `${LOCAL_IMAGE_SCHEME}${token}`;
  return img.getAttribute(CANONICAL_SRC_ATTR) || img.getAttribute("src") || "";
}

// ── One key both sides of the pairing can agree on ─────────────────────────
//
// enhanceSurfaceImageControls pairs a rendered shell with the markdown slice it
// came from by URL, and the two are not the same string. marked runs its own
// cleanUrl over an image destination before writing the `src`, so a URL holding
// a space, a non-ASCII character, or any of [ ] | { } ^ ` renders percent-
// encoded while the markdown still holds it as written:
//
//   ![a](https://x.test/Über.png)      -> src="https://x.test/%C3%9Cber.png"
//   ![a](<https://x.test/u v.png>)     -> src="https://x.test/u%20v.png"
//
// Compared raw, those miss — and a miss is silent: the picture keeps its Zoom
// pill and loses its resize grip and its delete button, on every render,
// forever. That is the report this is the fix for, and it lands hardest on
// clipped articles and pasted GIFs, whose URLs come from the web as written
// rather than from an upload path that slugs the filename.
//
// So both sides are put through marked's own transform rather than a guess at
// it: encodeURI, then the `%25` fixup that keeps an already-encoded URL from
// being encoded twice. It is idempotent, which is what lets the same function
// run over the source URL and over the `src` read back off the element.
export function markedImageUrl(url) {
  const text = String(url ?? "");
  try {
    return encodeURI(text).replace(/%25/g, "%");
  } catch (_) {
    // encodeURI throws only on a lone surrogate. marked's own cleanUrl gives
    // up there too (it returns null and the image renders with no src at all),
    // so matching raw is the best answer left rather than an exception on the
    // tail of every render.
    return text;
  }
}

// ...and the Drive rewrite on top, so a share link and a thumbnail link are one
// image here the same way they are one image to the renderer.
export function imageMatchKey(url) {
  return normalizeImageUrl(markedImageUrl(String(url ?? "").trim()));
}

// Sizing is stored as an absolute pixel width (not a percentage of whatever
// happens to contain it), so it's stable regardless of viewport width changes.
//
// The class is written beside the style, and it is not decoration: it is what
// excuses the tag from `#notesView .diagram-shell img:not(.has-custom-size) {
// width: auto !important }` (06-rendered.css), which an inline non-important
// `width` loses to outright. Without it a freshly committed width painted at the
// picture's OLD size until enhanceSurfaceImageControls added the class on the
// tail of the render — up to 300ms later on a big note, which is the snap-back
// on letting go of the grip. Same thing preprocessSpecialBlocks already writes
// for a resized diagram (src/render/preprocess.js), and styles/50-image-width.css
// covers the widths already sitting in notes with no class on them.
export function imgTagHtml({ url, alt = "", widthPx = null }) {
  if (!widthPx) return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`;
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" class="has-custom-size"`
    + ` style="--notes-img-w:${widthPx}px; width:${widthPx}px">`;
}

// ── Writing one image back into the note ───────────────────────────────────
//
// Both commits below come through here. The source is re-scanned rather than
// trusting offsets captured when the grip was attached: the reader can edit
// the note while a grip sits on screen, so the only safe identity at commit
// time is the one the scan can re-derive — this image's URL, and which copy of
// it this is. `build(image)` returns the replacement text; an empty string
// means "remove it".
//
// One slice is spliced and the rest of the note is left byte-identical, which
// is the whole difference from the token-array rebuild this replaced.

// The Nth image with this URL, or null. A single occurrence is unambiguous
// whatever `nth` says — the note has been edited underneath the control and
// this is still the only copy of that image in it.
//
// imageMatchKey, not normalizeImageUrl: `ref.url` is the key the shell was
// paired on, so resolving a commit any other way would let attach and commit
// disagree about which image the reader is dragging.
// ── ...and `nth` only means something if both lists are the same list ──────
//
// `ref.nth` is counted over the SHELLS ON SCREEN and applied to the SLICES IN
// THE SOURCE. Those are two different lists whenever a note is built span by
// span, which is every book: earlier copies of the same URL sitting in unbuilt
// spans are not counted on the DOM side, so `nth` came out too small and this
// returned an EARLIER, OFF-SCREEN copy. The picture the reader pressed stayed;
// a different one vanished; pressing again took another. That is the whole of
// "I deleted one image and several others went with it", and it lands on
// exactly the notes that have images in them — every upload writes `![](url)`
// with empty alt, and an imported book reuses its figures.
//
// The attach pass already refuses that ordinal without a guard (resolveShellCopy
// below). This is the same guard, applied where it matters: `ref.copies` is how
// many shells the view holds for this URL, and `ref.built` is which of the
// note's images are in the DOM at all. When neither can settle it the answer is
// null, and replaceSourceImage says so out loud rather than guessing.
//
// A ref carrying no `copies` is one built by hand — tools/image-controls-check
// asks a different question with those, namely "given the right nth, is the
// right slice rewritten" — and keeps the old, unguarded reading.
export function sourceImageAt(images, ref) {
  const matches = images.filter((image) => imageMatchKey(image.url) === ref.url);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  if (!Number.isInteger(ref.copies)) return matches[ref.nth] ?? null;
  const copies = matches.map((image) => ({ image, index: images.indexOf(image) }));
  const resolved = resolveShellCopy(copies, ref.nth, { built: ref.built || null, domCount: ref.copies });
  return resolved ? resolved.image : null;
}

// ── ...and what to do when that lookup comes back empty ────────────────────
//
// The controls are now attached to every picture on an editable surface, paired
// or not (see enhanceSurfaceImageControls), so this is where a pairing the
// scan could not make gets one more chance — at the moment it matters, with
// everything the DOM knows in hand.
//
// The order is by how much each step assumes:
//
//   1. the URL, exactly as before. Answers every ordinary image.
//   2. the same URL in a scan that does NOT skip code — and only for a ref
//      that came from a shell (`rendered`). That flag is the whole licence for
//      this step: the caller has the ELEMENT in hand, so the renderer has
//      already ruled that this image is not code, whatever the scan thinks.
//      The plainest case is an <img> inside a <pre>: marked hands that block to
//      the page verbatim, so the browser paints a real picture, while
//      scanCodeRegions — correctly for its own question — calls the region code
//      and skips it. Without an element there is no such licence, and an
//      `![](…)` inside a fence stays untouchable text, which
//      tools/image-controls-check.mjs holds this to.
//   3. position: `ref.index` of `ref.total`, used only when the view holds
//      exactly as many image shells as the note holds image slices. That is
//      self-verifying — the two lists are the same length, so the nth of one
//      IS the nth of the other — and it is the answer when the URL on the
//      element and the URL in the markdown have stopped agreeing for a reason
//      nothing here has thought of yet.
//
// Anything past that returns null and the caller says so out loud, which is the
// one promise worth keeping: a control that cannot say which slice it acts on
// writes nothing at all.
export function sourceImageFor(source, ref) {
  if (!ref?.url) return null;
  const images = findSourceImages(source);
  // Which of the note's images are in the DOM at all, derived exactly as the
  // attach pass derives it — and only when the ref did not already bring one.
  const built = ref.built
    || (ref.view ? alignBuiltImages(images, notesLazyBuiltImages(ref.view)) : null);
  const found = sourceImageAt(images, built === ref.built ? ref : { ...ref, built });
  if (found) return found;

  if (!ref.rendered) return null;

  // Only when the strict scan knows nothing about this URL at all. If it found
  // copies and merely could not say WHICH, looking again in the regions it
  // excluded cannot break that tie — it can only add a copy the reader sees as
  // text, and picking that one is the single outcome this whole chain exists to
  // avoid.
  if (!images.some((image) => imageMatchKey(image.url) === ref.url)) {
    const loose = findSourceImages(source, { skipCode: false })
      .filter((image) => imageMatchKey(image.url) === ref.url);
    if (loose.length === 1) return loose[0];
    // Same guard as sourceImageAt: an ordinal counted on screen may only be
    // applied to a list the screen can be shown to describe.
    if (loose.length > 1 && ref.copies === loose.length && loose[ref.nth]) return loose[ref.nth];
  }

  if (Number.isInteger(ref.index) && ref.total === images.length && images[ref.index]) {
    return images[ref.index];
  }
  return null;
}

// One line that is two or more images separated by "|" — the side-by-side row
// renderImageRows turns into a `.notes-img-row`. Anchored and single-line
// (renderImageRows scans with /gm), and deliberately unable to match a GFM
// table row, which starts with its own leading "|".
export function pipeRowLinePattern() {
  return new RegExp(
    `^[^\\S\\n]*(?:${IMG_TOKEN_SOURCE})(?:[^\\S\\n]*\\|[^\\S\\n]*(?:${IMG_TOKEN_SOURCE}))+[^\\S\\n]*$`,
    "i"
  );
}

// What a delete should actually cut. The image's own slice, plus:
//
//   • the whole line when the image was alone on it (otherwise the note keeps
//     a blank line where the picture was, and two of them in a row where it
//     sat between paragraphs);
//   • the "|" beside it when the line is a side-by-side row, which would
//     otherwise be left starting or ending with a stray separator.
//
// Anything else — an image inside a sentence, a table cell, a bullet — takes
// exactly its own slice and nothing around it.
export function imageRemovalRange(source, image) {
  const lineStart = source.lastIndexOf("\n", Math.max(0, image.start - 1)) + 1;
  const newlineAt = source.indexOf("\n", image.end);
  const lineEnd = newlineAt === -1 ? source.length : newlineAt;
  const before = source.slice(lineStart, image.start);
  const after = source.slice(image.end, lineEnd);

  if (!`${before}${after}`.trim()) {
    let start = lineStart;
    let end = newlineAt === -1 ? source.length : newlineAt + 1;
    // The line sat in its own paragraph: one of the two blank lines that would
    // otherwise be left touching each other goes with it. At the end of a note
    // there is no line after, so the blank line in FRONT is the one to take —
    // without that, deleting the last picture in a note leaves it ending in
    // white space that grows by one every time.
    const blankBefore = lineStart >= 2 && source.slice(lineStart - 2, lineStart) === "\n\n";
    if (blankBefore && source.startsWith("\n", end)) end += 1;
    else if (blankBefore && end >= source.length) start -= 1;
    return { start, end };
  }

  if (pipeRowLinePattern().test(source.slice(lineStart, lineEnd))) {
    const previous = before.match(/[ \t]*\|[ \t]*$/);
    if (previous) return { start: image.start - previous[0].length, end: image.end };
    const next = after.match(/^[ \t]*\|[ \t]*/);
    if (next) return { start: image.start, end: image.end + next[0].length };
  }

  return { start: image.start, end: image.end };
}

export function replaceSourceImage(surface, ref, build) {
  const source = surface?.getSource?.() || "";
  const image = sourceImageFor(source, ref);
  if (!image) {
    showToast("Couldn't find that image in the note any more", "error");
    return false;
  }
  const replacement = build(image);
  const { start, end } = replacement ? image : imageRemovalRange(source, image);
  surface.setSource(source.slice(0, start) + replacement + source.slice(end));
  surface.rerender();
  scheduleDeckAutosave();
  return true;
}

// Commit a dragged width. Written as a raw <img> because that is the only
// form that can carry one (see imgTagHtml) — including for an image nested in
// a bullet or a table cell, which stays exactly where it sits.
export function commitSourceImageWidth(surface, ref, px) {
  const widthPx = Math.min(IMAGE_RESIZE_MAX_PX, Math.max(IMAGE_RESIZE_MIN_PX, Math.round(px)));
  replaceSourceImage(surface, ref, (image) => imgTagHtml({ url: image.url, alt: image.alt, widthPx }));
}

// Removes the image from its surface immediately (so the UI never waits on a
// network round-trip), then best-effort deletes its underlying storage object.
export function removeSourceImage(surface, ref) {
  let url = "";
  if (!replaceSourceImage(surface, ref, (image) => { url = image.url; return ""; })) return;
  // Only hard-delete the stored file once NO other reference to it survives in
  // this deck — a duplicated image (same URL used twice, or the `![](url)`
  // markdown copy-pasted) otherwise deletes the file out from under its other
  // copies, turning them into broken links. This is the deletion ImgBB's plain
  // public-link API never allowed from inside the app; guarding it keeps that
  // power from becoming accidental data loss. (A copy pasted into a *different*
  // deck is still not seen here — checking every deck is too costly — so cross-
  // deck reuse of the exact same uploaded URL remains a caveat, not the norm
  // since each upload gets a unique path.)
  if (url && !deckStillReferencesImage(url)) deleteSupabaseImage(url);
}

// True while ANY text in the open deck still points at `url` — the notes or
// either side of any card. Deleting an image from a card face has to check the
// whole deck, not just that face: the same upload is routinely pasted into the
// notes and then captured into a card, and hard-deleting the storage object
// because one of those copies went away turns every other one into a broken
// link.
export function deckStillReferencesImage(url) {
  if (!url) return true;
  if ((state.notes || "").includes(url)) return true;
  return state.masterCards.some(
    (card) => String(card.question || "").includes(url) || String(card.answer || "").includes(url)
  );
}

// Bottom-right corner-grip resize (the universal affordance): drag out from the
// corner to grow, in to shrink. Width is what's stored; height is auto, so
// aspect ratio is preserved for free. A live badge shows the current px width
// and its share of the surface's own column so sizing isn't guesswork.
// `bounds` lets a diagram use its own floor/ceiling (a diagram shrunk to 20px is
// unreadable in a way a small image isn't).
export function beginImageResize(event, shell, img, onCommit, refEl, bounds = null) {
  event.preventDefault();
  event.stopPropagation();
  shell.setPointerCapture?.(event.pointerId);
  const minWidth = bounds?.min ?? IMAGE_RESIZE_MIN_PX;
  const maxWidth = bounds?.max ?? IMAGE_RESIZE_MAX_PX;
  const startX = event.clientX;
  // For a diagram, `img` is the block that HOLDS the drawing and is as wide as
  // the column even when the <svg> inside is drawn narrower (the Style panel's
  // "visual width" setting). Start from what the user can actually see, so the
  // edge tracks the pointer from the first pixel of the drag.
  const drawn = img.tagName === "IMG" ? img : img.querySelector("svg") || img;
  const startWidth = drawn.getBoundingClientRect().width || shell.getBoundingClientRect().width;
  const refWidth = refEl?.clientWidth || el.notesView?.clientWidth || 600;
  let widthPx = Math.round(startWidth);

  const badge = document.createElement("div");
  badge.className = "notes-img-size-badge";
  shell.appendChild(badge);
  const paintBadge = () => {
    const pct = Math.round((widthPx / refWidth) * 100);
    badge.textContent = `${widthPx}px · ${pct}%`;
  };

  shell.classList.add("is-resizing");
  // Native pointermove can fire well past 60/sec; writing style.width straight
  // from the event forces a layout on every one of them. rAF-batch it to at
  // most one write per rendered frame, keeping only the latest pointer x.
  let pendingEvent = null;
  let rafId = null;
  const applyMove = () => {
    rafId = null;
    const dx = pendingEvent.clientX - startX;
    widthPx = Math.min(maxWidth, Math.max(minWidth, Math.round(startWidth + dx)));
    img.style.setProperty("--notes-img-w", `${widthPx}px`);
    img.style.width = `${widthPx}px`;
    img.classList.add("has-custom-size");
    paintBadge();
  };
  const onMove = (e) => {
    pendingEvent = e;
    if (rafId == null) rafId = requestAnimationFrame(applyMove);
  };
  // A single teardown for every way the drag can end. Without also handling
  // pointercancel (fired when a touch/pen gesture is interrupted — scroll
  // takeover, second finger, the browser stealing the pointer), onUp would never
  // run: the live size badge would stay stranded in the DOM and the document
  // pointermove listener would leak, which is the "stray UI element that pops up
  // and won't go away" symptom.
  let finished = false;
  const end = (commit) => {
    if (finished) return;
    finished = true;
    if (rafId != null) cancelAnimationFrame(rafId);
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
    shell.classList.remove("is-resizing");
    badge.remove();
    if (commit) onCommit(widthPx);
  };
  const onUp = () => end(true);
  const onCancel = () => end(false); // interrupted — drop the badge, keep last live width
  paintBadge();
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.addEventListener("pointercancel", onCancel);
}

// ── A picture too small to hold its own controls ───────────────────────────
// The shell hugs its image (`width: fit-content` plus the 420px cap on an
// un-resized one), so on a 60px thumbnail the delete button, the grip and the
// Zoom pill are all painted on top of each other and on top of the picture —
// which is what "the controls are missing on small images" actually looks
// like. A tiny shell gets a floor to its size and a compact layout for the
// three (see styles/40-image-controls.css).
//
// Measured WITHOUT touching layout: this runs once per image on the tail of
// every render, and a getBoundingClientRect() each would be a forced reflow
// per picture on a note carrying dozens. The committed width if there is one,
// else the natural width under the same cap the stylesheet applies.
export const TINY_IMAGE_WIDTH_PX = 140;

export const UNSIZED_IMAGE_MAX_PX = 420;

export function markTinyImageShell(shell, node) {
  if (!shell || !node) return;
  const apply = () => {
    // A picture that FAILED is not a tiny picture. It has no natural width at
    // all, so this used to fall out at the `!width` line below and leave the
    // shell hugging a 0x0 image — 82x50 measured, which is not enough room for
    // the grip, the delete button and the Zoom pill, and they were painted on
    // top of each other inside it. A broken image gets its own floor instead
    // (.has-broken-image, styles/47-broken-image.css).
    if (isBrokenImage(node)) {
      shell.classList.remove("is-tiny-image");
      return;
    }
    const custom = parseInt(node.style.getPropertyValue("--notes-img-w"), 10);
    const natural = node.naturalWidth || 0;
    const width = custom > 0 ? custom : (natural ? Math.min(natural, UNSIZED_IMAGE_MAX_PX) : 0);
    // Not decoded yet and no committed width — nothing to judge it on, so the
    // listeners below ask again rather than guessing "tiny" and flashing the
    // compact layout onto a full-width photo.
    if (!width) return;
    shell.classList.toggle("is-tiny-image", width < TINY_IMAGE_WIDTH_PX);
  };
  apply();
  // Both events, and not `once`: the src of a rendered image is rewritten after
  // the render (hydrateLocalImages swaps in a blob: URL, resolveStorageImages a
  // signed one), and each rewrite is another load or another failure to judge.
  // Bound once per element, because this runs again on every enhance pass and
  // a listener per pass on a book full of screenshots is its own leak.
  if (node.tagName === "IMG" && !node.dataset.sizeWatch) {
    node.dataset.sizeWatch = "1";
    node.addEventListener("load", apply);
    node.addEventListener("error", apply);
  }
}

// Attaches the blue corner-drag resize grip and a delete button to an image.
// `onCommit(widthPx)` persists the final size and `onDelete()` removes the
// image — the caller supplies the right write path for each. These are the
// only image controls: every rendered image on an editable surface gets them,
// wherever its markdown sits (a bullet, a table cell, a link, mid-sentence),
// with no intermediate "move to own line" step.
// `onDelete` may be null for a target that only resizes (a diagram, whose source
// is a fenced code block the user edits as text).
// What each shell's controls currently act on, read AT EVENT TIME rather than
// captured in the listener's closure. That indirection is the whole point of
// the rewrite below: the grip and the delete button used to be REMOVED and
// rebuilt on every pass, and this pass runs on the tail of every render, on
// every lazily-built span, and on every placeholder-upgrade batch. A pass
// landing between a finger going down on the delete button and the click it
// would have produced took that very button out of the DOM, so the click had
// nothing to dispatch to — which is the desktop half of "sometimes the delete
// button does nothing". The elements now survive; only their binding changes.
export const imageControlBindings = new WeakMap();

export function attachNotesImageResizeHandle(shell, img, onCommit, onDelete, refEl, bounds = null) {
  imageControlBindings.set(shell, { node: img, onCommit, onDelete, refEl, bounds });
  // Surface-agnostic marker for the stylesheets, so a control does not have to
  // be styled once per view id (see styles/47-broken-image.css).
  shell.classList.add("is-editable-image");
  // `.notes-img-controls` is the box these two replaced; only ever removed.
  shell.querySelector(".notes-img-controls")?.remove();
  markTinyImageShell(shell, img);

  if (!shell.querySelector(".notes-img-resize-handle")) {
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "notes-img-resize-handle";
    resizeHandle.title = "Drag to resize";
    resizeHandle.setAttribute("aria-hidden", "true");
    resizeHandle.addEventListener("pointerdown", (e) => {
      const bound = imageControlBindings.get(shell);
      if (!bound) return;
      beginImageResize(e, shell, bound.node, bound.onCommit, bound.refEl, bound.bounds);
    });
    shell.appendChild(resizeHandle);
  }

  // A target that only resizes (a diagram, whose source is a fenced code block
  // the reader edits as text) drops the button if it ever had one.
  if (!onDelete) {
    shell.querySelector(".notes-img-delete-btn")?.remove();
    return;
  }

  if (!shell.querySelector(".notes-img-delete-btn")) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "notes-img-delete-btn";
    deleteBtn.title = "Remove image";
    deleteBtn.setAttribute("aria-label", "Remove image");
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      imageControlBindings.get(shell)?.onDelete?.();
    });
    shell.appendChild(deleteBtn);
  }
}

// ── Which copy of a repeated image is this one? ────────────────────────────
//
// An image is identified by its URL, which is enough for the overwhelming
// majority of them: an upload gets its own storage path, so one URL is one
// picture. The exception is a note that uses the SAME image twice, and it is
// the exception that has been costing readers their controls.
//
// The old rule was "if a URL repeats and the note is only partly built, skip
// it, and pick the copies up on the pass that runs when the last span lands".
// NOTES_LAZY_MIN_CHARS is 200,000 characters, so every imported book is built
// span by span and notesLazyPending stays true until the reader has scrolled
// the whole book end to end. That pass does not run in practice, so a figure a
// book shows twice had a Zoom pill and nothing else, permanently.
//
// Three answers now, in order, and only the last one gives up:
//
//   • one copy in the source — unambiguous whatever is on screen;
//   • as many shells for this URL in the DOM as there are slices in the source
//     — then the nth on screen IS the nth in the note, partial or not;
//   • `built` says which slices are in the DOM right now (block-cache derives
//     it from the lazy span plan), so the visible copies can be counted off
//     against the shells even when the rest of the book is still folded away.
//
// The give-up case is a WHOLE note holding more slices than shells, which means
// some of those slices render nothing — an image inside code the scan still
// reports (see scanCodeRegions). There the nth on screen names no particular
// slice, so this says so.
//
// Saying so no longer costs the reader their controls: null here means the
// width sync above is skipped and the shell is marked data-image-bind
// ="unmatched", and the question is asked again — with a whole-view ordinal and
// a source that may since have been built out — if a control is ever used. See
// sourceImageFor.
export function resolveShellCopy(copies, nth, { built = null, domCount = null } = {}) {
  if (copies.length === 1) return copies[0];
  if (domCount === copies.length) return copies[nth] || null;
  if (built) {
    const visible = copies.filter((copy) => built[copy.index] !== false);
    if (visible.length === domCount) return visible[nth] || null;
  }
  return null;
}

// `builtImages` — what block-cache knows about a lazily built note: one entry
// per image in the DOCUMENT it rendered, in order, each saying whether its span
// is currently in the DOM. Turned into a flag per image of THIS surface's own
// scan, or null when the two cannot be shown to describe the same images.
// Handed over as a function and called only for a note that repeats an image,
// because deriving it is a whole-note scan and this runs on the tail of every
// render.
//
// The two lists are not always the same length, and legitimately so: the notes
// view renders the note's body while getSource() answers with the whole of
// state.notes, whose tail carries the machine-managed highlight-notes block
// (src/format/notes-fence.js). An image written into a highlight's note is in
// the source and not in the reading surface, so the rendered list is a PREFIX
// of the scanned one — verified key by key here, because a prefix that does not
// actually match is a mapping that would name the wrong slice.
export function alignBuiltImages(images, builtImages) {
  if (!Array.isArray(builtImages) || !builtImages.length) return null;
  if (builtImages.length > images.length) return null;
  const flags = new Array(images.length).fill(false);
  for (let i = 0; i < builtImages.length; i += 1) {
    if (builtImages[i]?.key !== imageMatchKey(images[i].url || "")) return null;
    flags[i] = Boolean(builtImages[i].built);
  }
  return flags;
}

// Re-attaches the resize grip / delete button after every render of an editable
// surface (the notes view or either card face).
//
// Rendering wraps EVERY <img> in a .diagram-shell (addDiagramZoomControl), and
// findSourceImages finds EVERY image in the markdown, so the two lists are
// finally the same list — whatever encloses the image. Pairing is by URL, read
// through sourceUrlForImage (so a signed or blob:-hydrated src still matches
// the href the markdown holds) and compared through imageMatchKey (so a
// rewritten Drive link does too, and so marked's own percent-encoding of a URL
// carrying a space or a non-ASCII character cannot make the two miss).
//
// No ordering is assumed, which is the point: an upload gets its own storage
// path, so a URL identifies one image outright, and a note that is only half
// built binds its built half correctly instead of going without controls
// entirely until the reader reaches the end of the book.
//
// ── Every picture gets its controls, whether or not this pass can pair it ──
//
// The pairing above used to be a PRECONDITION: a shell it could not match, or
// could not tell apart from another copy of the same image, was left with its
// Zoom pill and nothing else. Silently, on every render, forever. Four separate
// fixes each closed one more way for that matching to fail — an unencoded URL,
// a phantom image inside code, a repeated image in a book, a diagram gated on a
// complete DOM — and each left the rest, because they all shared one shape:
// identity has to be recovered AFTER the fact, and when the recovery fails the
// reader is told nothing.
//
// So the dependency is inverted. The grip and the delete button go on every
// image of an editable surface. What this pass works out is a HINT — recorded
// on the shell as data-image-bind, and used for the one thing it is needed for
// here, syncing the width the note holds onto the element. WHICH slice a
// control acts on is worked out when the control is used, by sourceImageFor,
// against the source as it is then and everything the DOM knows by then. If
// even that cannot say, the write is refused out loud (one toast) rather than
// guessed at — the one promise worth keeping is that a control never rewrites
// a slice that is not its own.
//
// A missing grip is not recoverable by the reader and cannot be reported. A
// refusal is both.
//
// There is no `partial` flag any more, and its absence is the point. It used to
// mean "a repeated image gets nothing until the whole note is here", which on a
// book meant "gets nothing". What a half-built note actually needs is not a
// flag but an answer, and `builtImages` is that answer.
//
// `builtImages` — which of the note's images are in the DOM right now, from
// block-cache's span plan. What makes a repeated image resolvable while the
// rest of the book is still folded away. See resolveShellCopy.
//
// `scope` — the nodes a span build just added, so a book being read gets each
// span's grips as that span lands rather than re-walking every shell built so
// far on every one. Ordinals are still counted over the WHOLE view: the second
// copy of an image is the second copy of it in the NOTE, not the second in
// whichever span happens to be building.
export function enhanceSurfaceImageControls(surface, { scope = null, builtImages = null } = {}) {
  const view = surface?.view;
  if (!view) return;
  // Cheapest test first — see sourceMayHaveImages. This runs on the tail of
  // every render of every surface, and most notes hold no images at all.
  //
  // The test is on the SOURCE and not on what the scan found, and the
  // difference is the whole point: a note whose markdown mentions no image at
  // all cannot own the pictures in its view, and gets nothing. A note that
  // mentions one the scan then failed to find is the case this pass exists to
  // stop being silent, so it goes all the way through.
  if (!sourceMayHaveImages(surface?.getSource?.() || "")) return;
  const images = surfaceSourceImages(surface);

  const byKey = new Map();
  images.forEach((image, index) => {
    const key = imageMatchKey(image.url || "");
    const copies = byKey.get(key);
    const copy = { image, index, nth: copies ? copies.length : 0 };
    if (copies) copies.push(copy);
    else byKey.set(key, [copy]);
  });

  // Everything below this line exists only for a note that uses one image more
  // than once — the only case a URL alone cannot answer. A whole-view walk and
  // a whole-note scan per pass would otherwise be paid by every book on every
  // span build, for nothing.
  let repeated = false;
  byKey.forEach((copies) => { if (copies.length > 1) repeated = true; });
  const built = repeated
    ? alignBuiltImages(images, typeof builtImages === "function" ? builtImages() : builtImages)
    : null;
  const ordinals = new Map();
  const domCounts = new Map();
  if (repeated) {
    view.querySelectorAll(".diagram-shell").forEach((node) => {
      const image = node.querySelector("img");
      if (!image) return;
      const key = imageMatchKey(sourceUrlForImage(image));
      const at = domCounts.get(key) || 0;
      domCounts.set(key, at + 1);
      ordinals.set(node, at);
    });
  }

  const shells = scope ? scopedQueryAll(scope, ".diagram-shell") : Array.from(view.querySelectorAll(".diagram-shell"));
  shells.forEach((shell) => {
    const img = shell.querySelector("img");
    if (!img) return;
    const key = imageMatchKey(sourceUrlForImage(img));
    const copies = byKey.get(key);
    const copy = copies?.length
      ? resolveShellCopy(copies, repeated ? (ordinals.get(shell) || 0) : 0, {
        built,
        domCount: repeated ? (domCounts.get(key) || 0) : 1
      })
      : null;

    img.draggable = false;
    shell.dataset.imageUrl = key;
    shell.dataset.imageNth = String(copy ? copy.nth : (repeated ? (ordinals.get(shell) || 0) : 0));
    // Which of the two this shell is, kept where devtools and
    // tools/image-render-check.mjs can both read it. "unmatched" is not a
    // failure to attach any more — it is a note to itself that this one will
    // be worked out again, with more to go on, if the reader ever uses it.
    shell.dataset.imageBind = copy ? "matched" : "unmatched";
    // Only for a shell whose slice is known: the width the NOTE says, which may
    // differ from what a previous render left on the element. An unmatched one
    // keeps whatever its own markup gave it — guessing "no width" there would
    // undo a committed size the scan simply could not find.
    if (copy) {
      if (copy.image.widthPx) {
        img.style.setProperty("--notes-img-w", `${copy.image.widthPx}px`);
        img.classList.add("has-custom-size");
      } else {
        img.classList.remove("has-custom-size");
      }
    }

    // Read when the control is USED, not now. `nth` and the position are both
    // facts about a DOM that is still being built on a book — by the time a
    // finger comes down on this grip, the note is far more likely to be able to
    // answer than it was on the pass that attached it. See sourceImageFor.
    // The key is read again here rather than captured, so it is arrived at the
    // same way the ordinals it is counted against are: off the elements as they
    // are at that moment. An upload landing while the note is on screen swaps a
    // recall-img: placeholder for its storage URL, and a ref built half from
    // then and half from now would be counting two different pictures.
    const refAt = () => imageRefForShell(view, shell, imageMatchKey(sourceUrlForImage(img)));
    attachNotesImageResizeHandle(shell, img,
      (px) => commitSourceImageWidth(surface, refAt(), px),
      () => removeSourceImage(surface, refAt()),
      view
    );
  });
}

// Everything the DOM can say about which slice this shell's picture is, asked
// at the moment a control is used:
//
//   nth    which copy of that URL this shell is, among the shells on screen
//   index  where it sits among ALL the image shells in the view, and
//   total  how many there are — the pair sourceImageFor's positional step
//          needs, and which are only meaningful together
//   copies how many shells in the view show this same URL, which is what makes
//          `nth` checkable rather than merely asserted
//   view   the surface itself, so a commit can ask which of the note's images
//          are built at all (notesLazyBuiltImages) the way the attach pass does
//
// A whole-view walk, which is affordable precisely because it happens once per
// drag or delete rather than on the tail of every render.
export function imageRefForShell(view, shell, key) {
  let nth = 0;
  let index = -1;
  let total = 0;
  // How many shells the VIEW holds for this URL, this one included. An ordinal
  // is only worth anything against a list it can be checked against, and this is
  // that check: sourceImageAt trusts `nth` when this agrees with how many slices
  // the source holds, and refuses when it does not. Without it, a book with an
  // unbuilt span in front of the reader answered "copy 0" for a picture that is
  // really copy 3, and deleting it took copy 0 instead.
  let copies = 0;
  view.querySelectorAll(".diagram-shell").forEach((node) => {
    const img = node.querySelector("img");
    if (!img) return;
    const matches = imageMatchKey(sourceUrlForImage(img)) === key;
    if (matches) copies += 1;
    if (node === shell) index = total;
    else if (index === -1 && matches) nth += 1;
    total += 1;
  });
  // The shell is not in the view any more: a render landed between the finger
  // going down and the drag ending, and this element has been replaced by its
  // successor. The walk above counted every copy rather than the ones in front
  // of it, so it says nothing — but what the attach pass wrote on the shell
  // still does, and it was true of the note this drag started in.
  if (index === -1) {
    const stored = Number.parseInt(shell?.dataset?.imageNth ?? "", 10);
    return {
      url: key, nth: Number.isInteger(stored) ? stored : 0,
      index: null, total, copies, view, rendered: true
    };
  }
  // `rendered` says where this ref came from, and it is what licenses
  // sourceImageFor's recovery steps: there is an element on screen for this
  // picture, so the renderer has already ruled that it is not code.
  return { url: key, nth, index, total, copies, view, rendered: true };
}

// ── Editable diagrams: the same corner-drag resize images get ──────────────
// A mermaid/nomnoml diagram renders as a picture, so it should be sizeable like
// one. Its source is a fenced code block rather than an <img>, so the width is
// written back into the fence's info string (```mermaid w=520 — see
// parseDiagramWidth) instead of onto a tag.
//
// The mapping used to be by ordinal position alone, on the reasoning that
// preprocessSpecialBlocks turns every diagram fence into exactly one
// .mermaid/.nomnoml-diagram element in source order. That is true of a WHOLE
// note and false of one built as it is read, where the spans in the DOM are
// whichever ones the reader has been near — so the pass was skipped outright
// while any span was missing, and on a book it was skipped for good.
//
// A drawing carries the fence's own body in data-diagram, so it can be found by
// what it draws instead: content, not position, exactly as an image is found by
// its URL. See enhanceSurfaceDiagramControls.

export function findDiagramFences(source) {
  return scanFences(source)
    .filter((fence) => /\b(?:mermaid|nomnoml)\b/i.test(fence.info))
    .map((fence) => ({
      start: fence.start,
      headEnd: fence.headEnd,
      indent: fence.indent,
      marker: fence.marker,
      info: fence.info,
      // The drawing on screen carries this same text in data-diagram, which is
      // how a diagram is paired with its fence without counting positions.
      body: fence.body,
      widthPx: parseDiagramWidth(fence.info)
    }));
}

export function commitDiagramWidth(surface, fenceIndex, px) {
  const widthPx = Math.min(DIAGRAM_WIDTH_MAX, Math.max(DIAGRAM_WIDTH_MIN, Math.round(px)));
  const source = surface.getSource() || "";
  const fence = findDiagramFences(source)[fenceIndex];
  if (!fence) return;
  // The fence's own indent and marker, not a hardcoded "```": the scan starts
  // the slice at the indentation now, and a ~~~ fence is a fence too, so
  // rewriting one as an unindented ``` would move the block out of its list
  // item or change what closes it.
  const head = `${fence.indent}${fence.marker}${fenceInfoWithWidth(fence.info, widthPx)}`;
  surface.setSource(source.slice(0, fence.start) + head + source.slice(fence.headEnd));
  surface.rerender();
  scheduleDeckAutosave();
}

// The body a drawing was made from, read back off the element. Written there by
// preprocessSpecialBlocks as data-diagram and only ever READ afterwards (see
// renderDiagramNodes), so it survives the drawing being deferred, drawn, and
// re-drawn on a theme flip.
export function diagramBodyOf(node) {
  const encoded = node?.dataset?.diagram;
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded).trim();
  } catch (_) {
    return "";
  }
}

// `partial` — the note is lazily built and spans are still missing. It used to
// mean "attach nothing at all": finalizeRenderedSurface skipped this whole pass
// while any span was unbuilt, and on a note over NOTES_LAZY_MIN_CHARS that is
// until the reader has scrolled the book end to end. Every diagram in every
// imported book therefore had a Zoom pill, no resize grip and no delete button,
// every time — not sometimes.
//
// It is only the POSITIONAL walk that a half-built DOM breaks, and a diagram
// does not have to be found by position: preprocessSpecialBlocks writes the
// fence's own body onto the element, so a drawing can be paired with its fence
// by what it draws, exactly the way an image is paired by its URL. Position is
// the fallback for a drawing that carries no body, and stays gated on a whole
// note as it always was.
export function enhanceSurfaceDiagramControls(surface, { partial = false } = {}) {
  const view = surface?.view;
  if (!view) return;
  // Before the fence walk, not after it. The `diagrams.length` test below is
  // the real gate and it always was — but it sat downstream of a regex walk of
  // the whole note, so a book with no diagrams in it paid for the walk on every
  // single render just to be told there was nothing to do.
  if (!sourceMayHaveDiagrams(surface.getSource?.() || "")) return;
  const fences = findDiagramFences(surface.getSource());
  const diagrams = Array.from(view.querySelectorAll(".mermaid, .nomnoml-diagram"));
  if (!diagrams.length || !fences.length) return;

  const byBody = new Map();
  fences.forEach((fence, index) => {
    const key = String(fence.body || "").trim();
    const found = byBody.get(key);
    if (found) found.push(index);
    else byBody.set(key, [index]);
  });
  // How many drawings on screen came from each fence body — the same count
  // resolveShellCopy uses to know whether an ordinal among duplicates is
  // trustworthy on a half-built note.
  const domCounts = new Map();
  diagrams.forEach((node) => {
    const key = diagramBodyOf(node);
    domCounts.set(key, (domCounts.get(key) || 0) + 1);
  });

  // The positional fallback. "Disagree" is deliberately not
  // `diagrams.length !== fences.length`: a diagram is drawn deferred
  // (.is-diagram-pending, see render/deferred-work.js), so a note read from the
  // top routinely has fewer elements in the DOM than fences in the source. Only
  // a DOM holding MORE diagrams than the source has fences means the two lists
  // have genuinely lost each other.
  const positional = !partial && diagrams.length <= fences.length;

  const seen = new Map();
  diagrams.forEach((node, position) => {
    const shell = node.parentElement;
    if (!shell?.classList.contains("diagram-shell")) return;
    const body = diagramBodyOf(node);
    const matches = body ? byBody.get(body) : null;
    let index = -1;
    if (matches?.length === 1) {
      index = matches[0];
    } else if (matches?.length > 1 && domCounts.get(body) === matches.length) {
      // Two fences drawing the same thing, and every one of them is on screen:
      // the nth drawing IS the nth fence.
      const at = seen.get(body) || 0;
      seen.set(body, at + 1);
      index = matches[at] ?? -1;
    } else if (positional) {
      index = position;
    }
    if (index < 0 || index >= fences.length) return;

    const widthPx = fences[index].widthPx;
    if (widthPx) {
      node.style.setProperty("--notes-img-w", `${widthPx}px`);
      node.style.width = `${widthPx}px`;
      node.classList.add("has-custom-size");
    }
    attachNotesImageResizeHandle(
      shell,
      node,
      (px) => commitDiagramWidth(surface, index, px),
      null,
      view,
      { min: DIAGRAM_WIDTH_MIN, max: DIAGRAM_WIDTH_MAX }
    );
  });
}
