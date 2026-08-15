// What makes a huge note repaint quickly: markdown is split into blocks, each
// block's rendered DOM is cached by its source text, and a repaint patches only
// the blocks that actually changed.
//
// The height estimate matters more than it looks. Blocks off screen are laid
// out from contain-intrinsic-size, and an estimate that is wrong by 40% makes
// the scrollbar jump around while you read.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { hydrateLocalImages } from "../images/outbox.js?v=__BUILD__";
import { enhanceSurfaceDiagramControls, enhanceSurfaceImageControls, imageSurfaceForView } from "../images/surface-controls.js?v=__BUILD__";
import { buildNotesToc } from "../notes/toc.js?v=__BUILD__";
import { enhanceRenderedMarkdown, promoteNotesHeadings } from "./enhance.js?v=__BUILD__";
import { SANITIZE_CONFIG, preprocessSpecialBlocks, safeHtmlFromPrepared } from "./preprocess.js?v=__BUILD__";

// ── Incremental rendering ──────────────────────────────────────────────────
// Flipping the notes between raw and rendered used to throw the entire rendered
// DOM away and rebuild it: reparse, re-sanitize, re-highlight every code block,
// re-typeset every formula and — the expensive part — redraw every mermaid
// diagram. On a 230KB note that was ~9 seconds per toggle, for a document that
// in the overwhelming majority of cases hadn't changed at all.
//
// So the render is now keyed by content. The preprocessed markdown is split into
// its top-level blocks and each block's rendered nodes are remembered with the
// block's exact source as the key. A re-render reuses the DOM of every block
// whose source is byte-identical and only builds the ones that actually changed:
// an unedited toggle touches nothing (and keeps your scroll position), a
// one-paragraph edit re-renders one paragraph.
//
// Only the three editable surfaces are cached — the notes view and both card
// faces, the ones a user toggles in and out of. Everything else (All Cards, the
// print roots, the paste preview) renders once into a container it just built,
// where a cache could never hit.
export const renderedBlockCache = new WeakMap();

export const renderSequence = new WeakMap();

// Bumped when something outside the markdown changes what a render would
// produce (the mermaid theme), which retires every cached block.
export let renderGeneration = 0;

export function invalidateRenderedBlockCache() {
  renderGeneration += 1;
}

// ── Coalesced surface finalization ─────────────────────────────────────────
// enhanceSurfaceImageControls re-lexes the WHOLE note (surfaceLexTokens),
// enhanceSurfaceDiagramControls re-scans it for diagram fences, and
// buildNotesToc re-queries every heading — each an O(whole document) pass.
// renderMarkdown runs them once, but EVERY placeholder-upgrade batch (one per
// scroll chunk on a large note) ran them again synchronously, turning a single
// render into O(document) × O(number of scroll batches). That is what made a
// large book crawl. These scans are idempotent and only exist to (re)bind the
// token indices / heading list against the current DOM, so it's safe — and
// vastly cheaper — to coalesce them: at most one pass per container per frame,
// shared by the render tail and every upgrade batch that lands in the same
// window.
export const surfaceFinalizeFrames = new WeakMap();

export function finalizeRenderedSurface(container) {
  const surface = imageSurfaceForView(container);
  if (surface) {
    enhanceSurfaceImageControls(surface);
    enhanceSurfaceDiagramControls(surface);
  }
  if (container === el.notesView) {
    buildNotesToc();
    scheduleNotesBlockEstimate(container);
  }
}

export function scheduleSurfaceFinalize(container, { sync = false } = {}) {
  if (sync) {
    const pending = surfaceFinalizeFrames.get(container);
    if (pending) {
      cancelAnimationFrame(pending);
      surfaceFinalizeFrames.delete(container);
    }
    finalizeRenderedSurface(container);
    return;
  }
  if (surfaceFinalizeFrames.get(container)) return; // already queued this frame
  const frame = requestAnimationFrame(() => {
    surfaceFinalizeFrames.delete(container);
    finalizeRenderedSurface(container);
  });
  surfaceFinalizeFrames.set(container, frame);
}

// ── Adaptive block-height estimate ─────────────────────────────────────────
// `content-visibility: auto` needs a guess for how tall a block it hasn't laid
// out yet will be (contain-intrinsic-size). That guess used to be a hardcoded
// 120px, which is far too tall for ordinary prose: on a 400KB note the document
// claimed 249,880px on first paint and shrank to 141,773px as the reader
// scrolled through it — 43% of the scroll range evaporating across 124 separate
// jumps. Every one of those is the scrollbar thumb resizing and the content
// under the cursor sliding, which is what made a long note feel broken to
// scroll, and it also quietly wrecked anything that restores a reading position
// (the raw<->rendered toggle, jump-to-heading, cross-device resume) because the
// height those compute against changed underneath them.
//
// The fix is to stop guessing globally and measure THIS note. What governs
// scroll stability is the TOTAL height, not any individual block, so one
// well-chosen number per note is enough — and beats a per-block model derived
// from source length, which was tried and came out worse.
//
// Getting that number right needs care in two places that both burned a first
// attempt at this:
//
// 1. A block whose layout content-visibility skipped reports the ESTIMATE from
//    contain-intrinsic-size as its offsetHeight, not its content's height — not
//    zero, as you might expect. Averaging "whatever is laid out right now"
//    therefore mostly re-reads the number we ourselves just wrote, and each
//    pass feeds on the last: on the 400KB note it climbed 120 -> 157px and made
//    the drift worse (-55% instead of -43%). So the sample must FORCE layout on
//    the blocks it measures (content-visibility: visible, restored right after)
//    rather than trusting whatever geometry happens to be available.
// 2. The sample has to be spread across the whole document, and a fixed stride
//    aliases badly against repetitive structure — on an endnote chapter of
//    alternating list/pre blocks a strided sample landed on the tall one nearly
//    every time (+21%). A golden-ratio low-discrepancy sequence spreads the
//    picks evenly without ever locking onto a period.
//
// The average is winsorized — every sample is clamped into the 10th..90th
// percentile band before averaging — because block heights are nowhere near
// normally distributed and a plain mean is at the mercy of a single outlier: one
// 200-item list or one full-page image is enough to drag it wildly off (that
// case measured -50% drift on a plain mean, -0.2% winsorized). Clamping the
// tails rather than discarding them (a trimmed mean) matters on heterogeneous
// notes, where the tall blocks are real content rather than freak values and
// dropping them outright under-estimates: a note of mixed headings, quotes and
// long paragraphs drifted +20.4% trimmed against +6.1% winsorized.
//
// Measured against real scroll-through drift on five note shapes — uniform
// prose, an endnote chapter, a list-then-prose note, 1500 one-line paragraphs,
// and mixed headings/quotes/paragraphs — this holds mean absolute drift to ~6%
// and worst case to 20%, against 38%/65% for the fixed 120px it replaces.
//
// Deliberately measured ONCE per note and never revised while scrolling: a
// revision re-sizes every not-yet-measured block at once, which is a single
// enormous jump (61,812px was observed) rather than the gradual settling it was
// meant to cure. Being approximately right before the reader starts moving is
// worth far more than converging on exactly right while they read.
export const NOTES_ESTIMATE_MIN_PX = 24;

export const NOTES_ESTIMATE_MAX_PX = 900;

// Under this there is nothing to gain: the browser lays out a screenful or two
// eagerly anyway, so almost every block is real and the estimate is unused.
export const NOTES_ESTIMATE_MIN_BLOCKS = 60;

export const NOTES_ESTIMATE_SAMPLE_SIZE = 48;

// Percentile band the sample is clamped into before averaging (winsorizing).
export const NOTES_ESTIMATE_WINSOR_RATIO = 0.10;

// Successive multiples of this mod 1 never repeat and never clump — the
// standard trick for spreading N picks over a range without aliasing.
export const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;

export let notesBlockEstimatePx = null;

// The note the current estimate was measured against — a different note's
// blocks say nothing about this one's.
export let notesBlockEstimateSource = null;

// Setter: an imported binding is read-only, and main.js resets it when the open note changes.
export function setNotesBlockEstimateSource(value) {
  notesBlockEstimateSource = value;
}

export let notesBlockEstimateFrame = 0;

export function measureNotesBlockEstimate(container) {
  if (container !== el.notesView || !container) return;
  if (notesBlockEstimatePx != null) return; // one measurement per note, by design

  // The BLOCKS, not container.children — on a chunked note those are wrappers
  // of 40, and measuring them would set an estimate 40x too large for the very
  // notes the estimate matters most on.
  const blocks = notesTopLevelBlocks(container).filter((node) => node.nodeType === 1);
  if (blocks.length < NOTES_ESTIMATE_MIN_BLOCKS) return;

  const wanted = Math.min(NOTES_ESTIMATE_SAMPLE_SIZE, blocks.length);
  const picked = [];
  const seen = new Set();
  for (let i = 0; picked.length < wanted && i < wanted * 4; i += 1) {
    const index = Math.floor(((i * GOLDEN_RATIO_CONJUGATE) % 1) * blocks.length);
    if (seen.has(index)) continue;
    seen.add(index);
    picked.push(blocks[index]);
  }
  if (!picked.length) return;

  // Both loops stay separate from the read below so the forced layout happens
  // once for the whole sample instead of once per block.
  //
  // The CHUNK has to be forced too, not just the block. On a chunked note the
  // containment lives on the wrapper (#notesView > .notes-chunk), so forcing the
  // block alone changes nothing — its chunk is still skipped, offsetHeight comes
  // back 0, the winsorized mean is 0 and the `mean <= 0` guard below bails out.
  // The estimate then never lands at all, --notes-chunk-estimate keeps its
  // 4800px fallback, and the document's claimed height is fiction on exactly the
  // notes this whole mechanism exists for.
  const forced = new Set(picked);
  picked.forEach((node) => {
    const chunk = chunkAncestor(node, container);
    if (chunk) forced.add(chunk);
  });
  forced.forEach((node) => { node.style.contentVisibility = "visible"; });
  // Border-box height only, deliberately WITHOUT margins. contain-intrinsic-size
  // stands in for the element's own box; its margins sit outside it and are
  // applied whether or not the contents were skipped. Adding them here also
  // double-counted every collapsed margin between adjacent blocks (each gap
  // counted once as the block above's bottom and again as the block below's
  // top), which inflated the estimate by ~60% and left 30% of the drift in
  // place even once the sampling itself was right.
  const heights = picked.map((node) => node.offsetHeight);
  forced.forEach((node) => { node.style.removeProperty("content-visibility"); });
  // removeProperty leaves an empty style="" behind, which is invisible to the
  // reader but makes a re-rendered block differ from a freshly built one —
  // enough to fail the render-equivalence check the block cache is verified
  // with. Deferred a frame because removing it inline here does not stick while
  // the blocks are still being re-skipped by content-visibility. Blocks that
  // carry real inline styles (a sized image) have style.length > 0 and keep theirs.
  requestAnimationFrame(() => {
    forced.forEach((node) => { if (!node.style.length) node.removeAttribute("style"); });
  });

  heights.sort((a, b) => a - b);
  const at = (ratio) => heights[Math.min(heights.length - 1, Math.max(0, Math.floor(heights.length * ratio)))];
  const low = at(NOTES_ESTIMATE_WINSOR_RATIO);
  const high = at(1 - NOTES_ESTIMATE_WINSOR_RATIO);
  const mean = heights.reduce((sum, h) => sum + Math.min(Math.max(h, low), high), 0) / heights.length;
  if (!Number.isFinite(mean) || mean <= 0) return;

  notesBlockEstimatePx = Math.min(NOTES_ESTIMATE_MAX_PX, Math.max(NOTES_ESTIMATE_MIN_PX, mean));
  container.style.setProperty("--notes-block-estimate", `${Math.round(notesBlockEstimatePx)}px`);
  // A chunk stands in for NOTES_CHUNK_SIZE blocks, so its own placeholder height
  // is that multiple. Same reasoning as the per-block estimate: get it wrong and
  // the document's claimed height collapses as the reader scrolls, which is what
  // makes a long note feel broken.
  container.style.setProperty("--notes-chunk-estimate", `${Math.round(notesBlockEstimatePx * NOTES_CHUNK_SIZE)}px`);
}

// A new note's blocks have nothing to do with the previous one's, so the old
// mean must not carry over — it would be applied to the first paint of content
// it was never measured against.
export function resetNotesBlockEstimate() {
  notesBlockEstimatePx = null;
  el.notesView?.style.removeProperty("--notes-block-estimate");
  // Both, or the previous note's chunk placeholder survives into this one and
  // the new note's scroll height is sized by content it was never measured on.
  el.notesView?.style.removeProperty("--notes-chunk-estimate");
}

export function syncNotesBlockEstimateSource() {
  if (notesBlockEstimateSource === state.notes) return;
  setNotesBlockEstimateSource(state.notes);
  resetNotesBlockEstimate();
}

// Deferred to a frame rather than run inline: reading offsetHeight forces
// layout, and the render tail is the one moment we most want to hand back to
// the browser so it can paint. A frame later the blocks near the viewport have
// real geometry, which is exactly what this needs to sample.
export function scheduleNotesBlockEstimate(container) {
  if (container !== el.notesView) return;
  if (notesBlockEstimateFrame) return;
  notesBlockEstimateFrame = requestAnimationFrame(() => {
    notesBlockEstimateFrame = 0;
    measureNotesBlockEstimate(el.notesView);
  });
}

export function isCachedRenderSurface(container) {
  return container === el.notesView || container === el.questionView || container === el.answerView;
}

// The block boundaries of already-preprocessed markdown, as exact source slices.
// marked's lexer is the authority on where one top-level block ends and the next
// begins (the image-resize commits lean on the same guarantee), so a list with
// blank lines between its items stays one block instead of being sliced into
// several lists.
//
// Link reference definitions ([id]: url) are the one thing that isn't local to
// its block: they produce no output of their own but any block in the document
// can point at them, and marked collects them onto the token list as `.links`
// rather than leaving them in the stream. Rebuilding them into a `prelude` that
// is parsed in front of each block is what keeps `[text][id]` a link when its
// definition lives twenty blocks away.
export function definitionPrelude(links) {
  return Object.entries(links || {})
    .map(([label, link]) => {
      if (!link || typeof link.href !== "string" || /[\n\r]/.test(label)) return "";
      const key = label.replace(/[\\[\]]/g, "\\$&");
      const href = /\s/.test(link.href) ? `<${link.href}>` : link.href;
      const title = link.title ? ` "${String(link.title).replace(/"/g, '\\"')}"` : "";
      return `[${key}]: ${href}${title}`;
    })
    .filter(Boolean)
    .join("\n");
}

// Returns null when there's nothing to render block-wise.
export function splitPreparedBlocks(prepared) {
  let tokens;
  try {
    tokens = marked.lexer(prepared);
  } catch (error) {
    return null;
  }
  const blocks = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (typeof token.raw !== "string" || !token.raw.trim()) continue;
    blocks.push(token.raw);
  }
  return blocks.length ? { blocks, prelude: definitionPrelude(tokens.links) } : null;
}

// A marker that survives sanitisation, so every changed block can be parsed and
// sanitized in ONE pass and then split back into per-block HTML.
export const BLOCK_BREAK_HTML = '\n<hr data-recall-block-break="1">\n';

export const BLOCK_BREAK_RE = /<hr\b[^>]*\bdata-recall-block-break\b[^>]*>/;

export function renderPreparedBlocks(sources, prelude = "") {
  const head = prelude ? prelude + "\n\n" : "";
  // Parse each block on its own: marked needs a block in isolation to detect
  // its structure (a heading, list, etc.). Joining them into ONE marked.parse
  // call with an <hr> separator breaks that — headings after the first block
  // come back as literal "## text" instead of <h2>, which is exactly the
  // broken/blank content seen on large notes. The per-block parse is correct;
  // the shared DOMPurify.sanitize pass below keeps it from being N sanitizes.
  const joined = sources.map((source) => marked.parse(head + source)).join(BLOCK_BREAK_HTML);
  const parts = DOMPurify.sanitize(joined, SANITIZE_CONFIG).split(BLOCK_BREAK_RE);
  if (parts.length === sources.length) return parts;
  // A marker was dropped, or the markdown contained one of its own. Either way
  // the split can't be trusted — sanitize each block on its own instead.
  return sources.map((source) => safeHtmlFromPrepared(head + source));
}

export function nodesFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.childNodes);
}

// ── Chunking, for notes far too long to lay out a block at a time ─────────
//
// `content-visibility: auto` per block skips the CONTENT of everything
// off-screen, but the browser still has to track and position one box per
// block. On a 4.1MB note that is 24,600 boxes, and it dominates: measured on a
// 390x844 profile, 122ms per scroll frame, of which 853ms of browser layout
// across a 30-step scroll against 11ms of our own JavaScript.
//
// Grouping the blocks into wrappers that carry the containment instead moves
// the count the engine tracks from 24,600 to ~600. Measured on the same note:
// **122ms -> 17ms per frame, layout 853ms -> 41ms.**
//
// Only above NOTES_CHUNK_MIN_BLOCKS. An ordinary note keeps precisely the DOM
// it has always had, so nothing about the common path changes. Chunking and
// paged mode never coexist either — but by an explicit gate in
// shouldChunkRenderedBlocks, not by the size limits happening to be disjoint
// (they are not; see the note there). That is what keeps a contained wrapper
// out of a layout where it would have to flow across a column break.
export const NOTES_CHUNK_SIZE = 40;

export const NOTES_CHUNK_MIN_BLOCKS = 2000;

export const NOTES_CHUNK_CLASS = "notes-chunk";

// Diagrams and tables are deliberately excluded from `content-visibility`
// (styles/12-notes.css:255) because their own IntersectionObservers need real
// geometry and paint containment would clip an image mid-resize. That exclusion
// is unreachable once the containment lives on a wrapper, so a block like that
// gets a chunk to itself, which is then opted out as a whole.
export function blockWantsOwnChunk(node) {
  return node.nodeType === 1
    && (node.classList.contains("diagram-shell") || node.classList.contains("markdown-table-wrap"));
}

// A CSS selector matching a top-level block in either shape. For closest().
export const NOTES_TOP_LEVEL_SELECTOR = `.notes-rendered > *, .notes-rendered > .${NOTES_CHUNK_CLASS} > *`;

export function isChunkedSurface(container) {
  return Boolean(container?.firstElementChild?.classList?.contains(NOTES_CHUNK_CLASS));
}

// Every top-level block of a rendered note, in document order, whichever shape
// the container is in. THE one definition — a consumer that reaches for
// `container.children` directly gets chunks instead of blocks the moment a note
// is long enough, and every one of them (the reading-line search, the anchor
// text window, the block estimate) then answers at 40-block granularity.
export function notesTopLevelBlocks(container) {
  if (!container) return [];
  return isChunkedSurface(container)
    ? Array.from(container.querySelectorAll(`:scope > .${NOTES_CHUNK_CLASS} > *`))
    : Array.from(container.children);
}

// Re-resolves a remembered block's nodes against the DOM as it is now. A node
// can have been wrapped since it was cached (every image and diagram gets a
// .diagram-shell, every table a .markdown-table-wrap), so what the block really
// owns is the top-level ancestor; anything no longer under `container` is gone
// and its block has to be re-rendered.
//
// "Top level" means a direct child of the container OR of one of its chunks.
// Stopping only at the container would resolve every block in a chunk to that
// same chunk, `claimed` would let exactly one of them through, and the other 39
// would read as "gone" — so every render of a chunked note would rebuild the
// whole note from source.
// The chunk wrapper `node` sits in, or null on an unchunked note. Anything that
// needs a block's REAL geometry has to reach this and turn its containment off
// first: `content-visibility` lives on the wrapper, so a skipped chunk answers
// for all 40 blocks inside it.
export function chunkAncestor(node, container) {
  const chunk = node?.parentElement;
  if (!chunk || chunk === container) return null;
  return chunk.classList?.contains(NOTES_CHUNK_CLASS) && chunk.parentNode === container ? chunk : null;
}

// Force `node`'s chunk to lay out, run `read`, then put the containment back.
// Returns whatever `read` returned. A no-op on an unchunked note.
export function withChunkRendered(node, container, read) {
  const chunk = chunkAncestor(node, container);
  if (!chunk) return read();
  const had = chunk.style.contentVisibility;
  chunk.style.contentVisibility = "visible";
  try {
    return read();
  } finally {
    if (had) chunk.style.contentVisibility = had;
    else {
      chunk.style.removeProperty("content-visibility");
      // Same cleanup as the estimate sampler: removeProperty leaves an empty
      // style="" behind, which is enough to fail the render-equivalence check.
      if (!chunk.style.length) chunk.removeAttribute("style");
    }
  }
}

export function isTopLevelBlockParent(node, container) {
  return node === container || (node?.classList?.contains(NOTES_CHUNK_CLASS) && node.parentNode === container);
}

export function liveBlockNodes(container, nodes, claimed) {
  const live = [];
  nodes.forEach((node) => {
    let top = node;
    while (top && top.parentNode && !isTopLevelBlockParent(top.parentNode, container)) top = top.parentNode;
    if (!top || !isTopLevelBlockParent(top.parentNode, container) || claimed.has(top)) return;
    claimed.add(top);
    live.push(top);
  });
  return live;
}

// Re-home every block into freshly built chunks, in order. Built in a fragment
// and swapped in once, so the container is touched a single time rather than
// once per block.
// Chunk only a long note in the notes view, and only while it is scrolling
// VERTICALLY.
//
// Paged mode was originally believed to be excluded already, because "paged
// refuses notes over 250KB". It is not: the two gates count different things —
// chunking is 2000 BLOCKS, paged declines 250,000 CHARS — so a 2000-block note
// averaging under 125 chars a block is both at once. When that happened the
// paged rule that turns containment off (styles/18-paged-notes.css, (0,3,0),
// matching direct children) no longer matched anything, because the direct
// children were chunks, and `#notesView > .notes-chunk` at (1,1,0) kept
// content-visibility on — a contained wrapper that cannot flow across a column
// break, which is precisely the case chunking was supposed to never meet. The
// class is read off the DOM rather than importing isNotesPaged() to keep this
// module free of a dependency on the paged view.
//
// applyNotesPagedLayout re-renders when the mode changes, so a note that is
// chunked in continuous mode is flattened on the way into pages and re-chunked
// on the way out.
export function shouldChunkRenderedBlocks(container, blockCount) {
  if (container !== el.notesView || blockCount < NOTES_CHUNK_MIN_BLOCKS) return false;
  return !container.classList.contains("is-paged");
}

// Put `container` into whichever shape shouldChunkRenderedBlocks now wants,
// without re-rendering anything. Called when the reading mode flips, where the
// blocks themselves are unchanged and only their grouping is wrong.
//
// The same NODES are moved, never rebuilt, so every cached block entry, the
// TOC's captured heading references and any live highlight all stay valid.
// Grouping one node per group on the way in is a hair coarser than the render
// path's per-BLOCK groups (a block owning several nodes could straddle a chunk
// boundary), which costs nothing: liveBlockNodes resolves each node to its own
// top-level ancestor either way, and the next render re-homes them properly.
export function reshapeRenderedChunks(container) {
  if (container !== el.notesView) return;
  const blocks = notesTopLevelBlocks(container).filter((node) => node.nodeType === 1);
  const want = shouldChunkRenderedBlocks(container, blocks.length);
  if (want === isChunkedSurface(container)) return;
  if (want) rechunkRenderedBlocks(container, blocks.map((node) => [node]));
  else container.replaceChildren(...blocks);
}

export function rechunkRenderedBlocks(container, groups) {
  const fragment = document.createDocumentFragment();
  let chunk = null;
  let filled = 0;
  const startChunk = () => {
    chunk = document.createElement("div");
    chunk.className = NOTES_CHUNK_CLASS;
    fragment.appendChild(chunk);
    filled = 0;
    return chunk;
  };
  groups.forEach((nodes) => {
    if (!nodes || !nodes.length) return;
    const solo = nodes.some(blockWantsOwnChunk);
    if (!chunk || filled >= NOTES_CHUNK_SIZE || solo) startChunk();
    if (solo) chunk.classList.add("is-uncontained");
    nodes.forEach((node) => chunk.appendChild(node));
    filled += 1;
    // A block that had to stand alone must not collect neighbours after it.
    if (solo) chunk = null;
  });
  container.replaceChildren(fragment);
}

// Rebuilds `container`'s children to match `blocks`, reusing the DOM of every
// block whose source is unchanged. Returns the new block list plus the nodes
// that were freshly built, which are the only ones needing enhancement.
export function patchRenderedBlocks(container, blocks, prelude, cached) {
  const pool = new Map(); // block source -> reusable node groups, in document order
  if (cached) {
    const claimed = new Set();
    cached.blocks.forEach((entry) => {
      const nodes = liveBlockNodes(container, entry.nodes, claimed);
      if (!nodes.length) return;
      const bucket = pool.get(entry.key);
      if (bucket) bucket.push(nodes);
      else pool.set(entry.key, [nodes]);
    });
  }

  const groups = new Array(blocks.length);
  const missing = [];
  blocks.forEach((key, index) => {
    const bucket = pool.get(key);
    const reused = bucket && bucket.length ? bucket.shift() : null;
    if (reused) groups[index] = reused;
    else missing.push(index);
  });

  // Large notes used to get lightweight placeholder nodes here, upgraded to
  // real content as they scrolled into view. That made the FIRST paint fast,
  // but the IntersectionObserver/estimate/scroll-compensation machinery was
  // fragile — it produced blank regions and jitter on big notes. The browser
  // already skips laying out off-screen blocks natively via
  // `content-visibility: auto` (see .notes-rendered > * in styles.css), which
  // is robust and needs none of that. So build every missing block as real
  // content now: the only cost is the synchronous marked.parse + one shared
  // DOMPurify.sanitize pass, and the incremental block cache means the common
  // raw<->rendered toggle (nothing edited) never pays it anyway.
  const fresh = [];
  if (missing.length) {
    const parts = renderPreparedBlocks(missing.map((index) => blocks[index]), prelude);
    missing.forEach((blockIndex, part) => {
      const nodes = nodesFromHtml(parts[part] ?? "");
      groups[blockIndex] = nodes;
      nodes.forEach((node) => fresh.push(node));
    });
  }

  if (shouldChunkRenderedBlocks(container, blocks.length)) {
    // Chunked: rebuild the wrapper structure and re-home every block into it.
    // The cursor walk below cannot be used here — it steps over
    // container.firstChild, which is a CHUNK, while the target order is per
    // BLOCK. Re-homing is O(n) appendChild on nodes that mostly already exist,
    // which against the 20-odd seconds a note this size takes to lay out at all
    // is not measurable.
    rechunkRenderedBlocks(container, groups);
  } else {
    // Walk the target order once: a node already in the right place is stepped
    // over, anything else is moved (reused) or inserted (fresh) in front of the
    // cursor. Whatever is left after the last block never made it into the new
    // document and is dropped.
    //
    // This also un-chunks correctly when a note shrinks below the threshold: the
    // blocks are moved out to the top level one by one, and the emptied chunks
    // are what the trailing sweep removes.
    let cursor = container.firstChild;
    groups.forEach((nodes) => {
      nodes.forEach((node) => {
        if (node === cursor) {
          cursor = cursor.nextSibling;
          return;
        }
        container.insertBefore(node, cursor);
      });
    });
    while (cursor) {
      const next = cursor.nextSibling;
      container.removeChild(cursor);
      cursor = next;
    }
  }

  return {
    blocks: blocks.map((key, index) => ({ key, nodes: groups[index] })),
    fresh
  };
}

// Rebuilding a view used to put every {{cloze}} back in its hidden state, and
// the flip-all button is reset to match after each render. Reused blocks keep
// whatever the reader flipped open, so hide them explicitly to keep that
// contract — otherwise the button and the text disagree.
export function resetRenderedClozes(container) {
  container.querySelectorAll(".cloze.is-revealed").forEach((node) => node.classList.remove("is-revealed"));
}

export async function renderMarkdown(container, markdown, allowPlaceholder = false) {
  let displayMarkdown = markdown;
  if (allowPlaceholder && (!markdown || String(markdown).trim() === "")) {
    if (container.closest(".all-card-question") || container.closest(".card-question")) {
      displayMarkdown = "<div class='empty-placeholder'>Question</div>";
    } else if (container.closest(".all-card-answer") || container.closest(".card-answer")) {
      displayMarkdown = "<div class='empty-placeholder'>Answer</div>";
    }
  }
  if (container === el.notesView) displayMarkdown = promoteNotesHeadings(displayMarkdown);

  const cacheable = isCachedRenderSurface(container);
  const cached = cacheable ? renderedBlockCache.get(container) : null;
  // The whole point: same content, same theme, and the DOM on screen is already
  // the answer. This is the raw → rendered toggle when nothing was edited.
  if (cached && cached.generation === renderGeneration && cached.source === displayMarkdown) {
    resetRenderedClozes(container);
    return;
  }

  const sequence = (renderSequence.get(container) || 0) + 1;
  renderSequence.set(container, sequence);

  const prepared = preprocessSpecialBlocks(displayMarkdown);
  const split = cacheable ? splitPreparedBlocks(prepared) : null;
  let roots = null;
  if (split) {
    // Every block is parsed behind the document's link reference definitions, so
    // a change to those changes what any block could render to: start over.
    const reusable = cached && cached.prelude === split.prelude ? cached : null;
    const patched = patchRenderedBlocks(container, split.blocks, split.prelude, reusable);
    roots = patched.fresh;
    resetRenderedClozes(container);
    // Committed before the awaits below: another render can start while mermaid
    // is drawing, and it must see the DOM as it actually is, not as it was.
    renderedBlockCache.set(container, {
      generation: renderGeneration,
      source: displayMarkdown,
      prelude: split.prelude,
      blocks: patched.blocks
    });
  } else {
    container.innerHTML = safeHtmlFromPrepared(prepared);
    if (cacheable) renderedBlockCache.delete(container);
  }

  await enhanceRenderedMarkdown(container, roots);
  // Images still waiting to upload live in IndexedDB behind a recall-img: URL,
  // which no browser can load directly — swap in a blob URL so they're visible
  // straight away rather than only after they eventually reach the cloud.
  await hydrateLocalImages(roots || container);
  if (renderSequence.get(container) !== sequence) return; // a newer render owns the view now
  // Notes AND both card faces are editable surfaces, so all three get the
  // resize/delete grips. Every other caller of renderMarkdown (All Cards, the
  // print root, the paste preview, the Quick Notes board) renders read-only and
  // imageSurfaceForView returns null for it. Always run over the whole surface,
  // never just the fresh blocks: an inserted or deleted block shifts the token
  // indices every other image's resize handler was bound to. Runs synchronously
  // here (the print/export path reads the grips right after this resolves).
  scheduleSurfaceFinalize(container, { sync: true });
}
