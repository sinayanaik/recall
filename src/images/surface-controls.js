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
import { IMG_ALT_SOURCE, IMG_DEST_SOURCE, IMG_TOKEN_SOURCE, imageDestinationUrl } from "../render/inline.js?v=__BUILD__";
import { DIAGRAM_WIDTH_MAX, DIAGRAM_WIDTH_MIN, fenceInfoWithWidth, normalizeImageUrl, parseDiagramWidth, scanFences } from "../render/preprocess.js?v=__BUILD__";
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

// Every image in a note's SOURCE, in document order, as
// { start, end, raw, url, alt, widthPx }.
//
// Fenced code is skipped — an `![](…)` inside a ``` block is text, and
// treating it as a picture would let a control rewrite something that never
// rendered — and so is one wrapped tightly in backticks, which is the same
// thing written inline. (A code span written with a doubled or spaced
// delimiter is still found; nothing renders for it, so no shell ever matches
// it, and the only cost is that a real image sharing that URL is treated as
// having a duplicate.)
export function findSourceImages(source) {
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
      const info = raw.startsWith("<") ? parseImgTagAttrs(raw)
        : raw.includes("](") ? parseMarkdownImage(raw)
        : parseReferenceImage(raw, definitions);
      if (!info || !info.url) continue;
      found.push({ start, end, raw, ...info });
    }
  };
  let at = 0;
  for (const fence of scanFences(text)) {
    scanGap(at, fence.start);
    at = fence.end;
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

// Sizing is stored as an absolute pixel width (not a percentage of whatever
// happens to contain it), so it's stable regardless of viewport width changes.
export function imgTagHtml({ url, alt = "", widthPx = null }) {
  const style = widthPx ? ` style="--notes-img-w:${widthPx}px; width:${widthPx}px"` : "";
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${style}>`;
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
export function sourceImageAt(images, ref) {
  const matches = images.filter((image) => normalizeImageUrl(image.url) === ref.url);
  if (!matches.length) return null;
  return matches[ref.nth] || (matches.length === 1 ? matches[0] : null);
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
  const image = sourceImageAt(findSourceImages(source), ref);
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

// Re-attaches the resize grip / delete button after every render of an editable
// surface (the notes view or either card face).
//
// Rendering wraps EVERY <img> in a .diagram-shell (addDiagramZoomControl), and
// findSourceImages finds EVERY image in the markdown, so the two lists are
// finally the same list — whatever encloses the image. Pairing is by URL, read
// through sourceUrlForImage (so a signed or blob:-hydrated src still matches
// the href the markdown holds) and compared through normalizeImageUrl (so a
// rewritten Drive link does too).
//
// No ordering is assumed, which is the point: an upload gets its own storage
// path, so a URL identifies one image outright, and a note that is only half
// built (see `partial`) binds its built half correctly instead of going
// without controls entirely until the reader reaches the end of the book.
//
// `partial` — the surface is a lazily built note with spans still missing.
// Only the ambiguous case cares: with the SAME image used more than once in
// one note, the nth copy on screen is the nth copy in the source only when the
// whole note is there. Those keep their Zoom pill and pick up their grips on
// the pass that runs when the last span lands (see finishNotesLazySpan).
//
// `scope` — the nodes a span build just added, so a book being read gets each
// span's grips as that span lands rather than re-walking every shell built so
// far on every one. Safe with `partial` for the same reason: the images it
// skips are exactly the ones a scoped count could get wrong.
export function enhanceSurfaceImageControls(surface, { partial = false, scope = null } = {}) {
  const view = surface?.view;
  if (!view) return;
  // Cheapest test first — see sourceMayHaveImages. This runs on the tail of
  // every render of every surface, and most notes hold no images at all.
  const images = surfaceSourceImages(surface);
  if (!images.length) return;

  const byUrl = new Map();
  images.forEach((image) => {
    const url = normalizeImageUrl(image.url || "");
    const copies = byUrl.get(url);
    if (copies) copies.push(image);
    else byUrl.set(url, [image]);
  });

  const seen = new Map();
  const shells = scope ? scopedQueryAll(scope, ".diagram-shell") : Array.from(view.querySelectorAll(".diagram-shell"));
  shells.forEach((shell) => {
    const img = shell.querySelector("img");
    if (!img) return;
    const url = normalizeImageUrl(sourceUrlForImage(img));
    const copies = byUrl.get(url);
    // A shell whose image is in no markdown this surface owns: an export root's
    // clone, a preview, something a plugin put there. Zoom pill only.
    if (!copies?.length) return;
    const nth = seen.get(url) || 0;
    seen.set(url, nth + 1);
    if (copies.length > 1 && partial) return;
    const image = copies[nth] || (copies.length === 1 ? copies[0] : null);
    if (!image) return;

    img.draggable = false;
    shell.dataset.imageUrl = url;
    shell.dataset.imageNth = String(nth);
    if (image.widthPx) {
      img.style.setProperty("--notes-img-w", `${image.widthPx}px`);
      img.classList.add("has-custom-size");
    } else {
      img.classList.remove("has-custom-size");
    }

    const ref = { url, nth };
    attachNotesImageResizeHandle(shell, img,
      (px) => commitSourceImageWidth(surface, ref, px),
      () => removeSourceImage(surface, ref),
      view
    );
  });
}

// ── Editable diagrams: the same corner-drag resize images get ──────────────
// A mermaid/nomnoml diagram renders as a picture, so it should be sizeable like
// one. Its source is a fenced code block rather than an <img>, so the width is
// written back into the fence's info string (```mermaid w=520 — see
// parseDiagramWidth) instead of onto a tag.
//
// The DOM→source mapping is by ordinal position, which is exact here in a way it
// isn't for images: preprocessSpecialBlocks turns every diagram fence into
// exactly one .mermaid/.nomnoml-diagram element, in source order, wherever the
// fence sits. Walking the shared scanFences() keeps the two lists in lockstep;
// if the counts ever disagree, no grip is attached rather than a grip that would
// resize the wrong diagram.
//
// "Disagree" used to mean `diagrams.length !== fences.length`, which is a
// stronger test than the mapping needs and made one late diagram cost every
// diagram in the note its grip. A diagram is drawn deferred (.is-diagram-pending,
// see render/deferred-work.js), so a note read from the top routinely has fewer
// elements in the DOM than fences in the source for as long as the reader has
// not scrolled to the last one. The elements that ARE there are still the first
// N fences in order, so the pairing is exact for them: only a DOM holding MORE
// diagrams than the source has fences means the two lists have genuinely lost
// each other, and that is the case that still refuses to attach anything.
export function findDiagramFences(source) {
  return scanFences(source)
    .filter((fence) => /\b(?:mermaid|nomnoml)\b/i.test(fence.info))
    .map((fence) => ({
      start: fence.start,
      headEnd: fence.headEnd,
      indent: fence.indent,
      marker: fence.marker,
      info: fence.info,
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

export function enhanceSurfaceDiagramControls(surface) {
  const view = surface?.view;
  if (!view) return;
  // Before the fence walk, not after it. The `diagrams.length` test below is
  // the real gate and it always was — but it sat downstream of a regex walk of
  // the whole note, so a book with no diagrams in it paid for the walk on every
  // single render just to be told there was nothing to do.
  if (!sourceMayHaveDiagrams(surface.getSource?.() || "")) return;
  const fences = findDiagramFences(surface.getSource());
  const diagrams = Array.from(view.querySelectorAll(".mermaid, .nomnoml-diagram"));
  if (!diagrams.length || diagrams.length > fences.length) return;

  diagrams.forEach((node, index) => {
    const shell = node.parentElement;
    if (!shell?.classList.contains("diagram-shell")) return;
    if (index >= fences.length) return;
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
