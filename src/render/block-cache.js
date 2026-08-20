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
import { markNotesTocDirty, refreshNotesTocAvailability } from "../notes/toc.js?v=__BUILD__";
import { chapterIndexFor } from "../notes/chapters.js?v=__BUILD__";
import { enhanceRenderedMarkdown, promoteNotesHeadings } from "./enhance.js?v=__BUILD__";
import { markdownLibrariesReady } from "../core/lib-guard.js?v=__BUILD__";
import { SANITIZE_CONFIG, preprocessSpecialBlocks, safeHtmlFromPrepared } from "./preprocess.js?v=__BUILD__";
import { DEFERRED_WORK_MARGIN } from "./deferred-work.js?v=__BUILD__";

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

// >0 while at least one large note's blocks are still being streamed in (see
// renderMarkdown/streamRenderedBlocks below). Read by ui/chrome.js and other
// callers that force a synchronous layout read from a generic UI action, so
// they can defer themselves rather than pay for the note's layout backlog.
//
// A COUNTER, not a boolean: an edit-triggered re-render can start on the same
// container while the initial cold stream of a big note is still in flight
// (e.g. a highlight applied the instant the note finishes appearing scrolls
// it, which re-renders the block under the cursor) — two overlapping streams
// that finish at different times. A shared boolean had the faster one clear it
// while the slower one was still mid-stream, silently reopening the exact
// forced-layout freeze this exists to prevent.
let notesStreamBusyCount = 0;

export function isNotesStreamBusy() {
  return notesStreamBusyCount > 0;
}

// The notes view is a single persistent element, so the WeakMap above holds
// exactly one entry for it — opening note B evicts note A's parsed cache, so
// switching back to A re-pays preprocessSpecialBlocks + marked.lexer (the
// synchronous, unyielded part of a render — see renderMarkdown) even though
// A's markdown hasn't changed. Reusing A's rendered DOM nodes isn't safe here
// (they may already be detached/re-chunked by B's render), so this only
// remembers the PARSE result — prepared markdown and the block-key list — by
// note id, small and bounded. A hit still goes through the normal
// patch/stream path to rebuild the DOM, which is the part that's already
// yielded and chunked; it just skips the one long synchronous pass.
export const NOTES_PARSE_HISTORY_LIMIT = 3;

export const notesParseHistory = new Map(); // noteId -> { source, prepared, split }

export function rememberNotesParseHistory(noteId, entry) {
  if (noteId == null) return;
  notesParseHistory.delete(noteId);
  notesParseHistory.set(noteId, entry);
  while (notesParseHistory.size > NOTES_PARSE_HISTORY_LIMIT) {
    const oldest = notesParseHistory.keys().next().value;
    notesParseHistory.delete(oldest);
  }
}

export function clearNotesParseHistory() {
  notesParseHistory.clear();
}

// Same identity a note keeps across sync/import/rename — a title change or a
// remote-id assignment must not look like a different note. Mirrors
// notes/scroll-anchor.js's currentDeckKey(); duplicated rather than imported
// because that module already imports FROM this one (block-cache.js ->
// scroll-anchor.js would be circular).
export function currentNotesParseKey() {
  return JSON.stringify([state.deckId || null, state.localDeckId || null, state.folderDeck?.path || null]);
}

export const renderSequence = new WeakMap();

// Bumped when something outside the markdown changes what a render would
// produce (the mermaid theme), which retires every cached block.
export let renderGeneration = 0;

export function invalidateRenderedBlockCache() {
  renderGeneration += 1;
}

// ── Coalesced surface finalization ─────────────────────────────────────────
// enhanceSurfaceImageControls re-lexes the WHOLE note (surfaceLexTokens),
// enhanceSurfaceDiagramControls re-scans it for diagram fences, and the notes
// tail re-derives the table of contents — each an O(whole document) pass.
// renderMarkdown runs them once, but EVERY placeholder-upgrade batch (one per
// scroll chunk on a large note) ran them again synchronously, turning a single
// render into O(document) × O(number of scroll batches). That is what made a
// large book crawl. These scans are idempotent and only exist to (re)bind the
// token indices / heading list against the current DOM, so it's safe — and
// vastly cheaper — to coalesce them: at most one pass per container per frame,
// shared by the render tail and every upgrade batch that lands in the same
// window.
export const surfaceFinalizeFrames = new WeakMap();

// How long the deferred tail may wait for an idle moment before it is run
// anyway. Long enough to let a first tap through, short enough that the block
// estimate is in place well before the reader can scroll anywhere near the
// bottom of what they can see.
export const SURFACE_FINALIZE_IDLE_TIMEOUT_MS = 300;

export function finalizeRenderedSurface(container) {
  const surface = imageSurfaceForView(container);
  if (surface) {
    enhanceSurfaceImageControls(surface);
    enhanceSurfaceDiagramControls(surface);
  }
  if (container === el.notesView) {
    // Not buildNotesToc(). The list is drawn when the drawer is looked at (see
    // notesTocDirty in toc.js) — all this tail owes is "the note changed", plus
    // the one thing that is visible with the drawer shut: whether the ☰ button
    // has a contents to offer.
    markNotesTocDirty();
    refreshNotesTocAvailability();
    scheduleNotesBlockEstimate(container);
    scheduleNotesChunkEstimates(container);
  }
}

export function scheduleSurfaceFinalize(container, { sync = false } = {}) {
  if (sync) {
    const pending = surfaceFinalizeFrames.get(container);
    if (pending) {
      if (pending.frame) cancelAnimationFrame(pending.frame);
      else if (pending.idle && typeof cancelIdleCallback === "function") cancelIdleCallback(pending.idle);
      surfaceFinalizeFrames.delete(container);
    }
    finalizeRenderedSurface(container);
    return;
  }
  if (surfaceFinalizeFrames.get(container)) return; // already queued
  // requestIdleCallback, not requestAnimationFrame. The frame immediately after
  // a big note renders is precisely when the reader's first press arrives —
  // they can see the text, so they believe the app is ready — and a rAF
  // callback runs BEFORE that press is delivered. An idle callback yields to
  // input; the timeout is the backstop so it still lands promptly on a page
  // that never goes idle. Cancellation goes through the matching canceller, so
  // the handle is stored with which kind it is.
  if (typeof requestIdleCallback === "function") {
    const idle = requestIdleCallback(() => {
      surfaceFinalizeFrames.delete(container);
      finalizeRenderedSurface(container);
    }, { timeout: SURFACE_FINALIZE_IDLE_TIMEOUT_MS });
    surfaceFinalizeFrames.set(container, { idle });
    return;
  }
  const frame = requestAnimationFrame(() => {
    surfaceFinalizeFrames.delete(container);
    finalizeRenderedSurface(container);
  });
  surfaceFinalizeFrames.set(container, { frame });
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

// ── Chunked lexing, for a cold render too large to lex in one synchronous call ──
//
// marked.lexer(prepared) is itself the single biggest piece of the unyielded
// pass renderMarkdown pays on a cold open (measured 125ms on a 2MB/18,061-block
// note — see the streaming comment below). Everything AFTER the parse is
// already yielded in batches; this and preprocessSpecialBlocks/
// promoteNotesHeadings are not, and there is no cache that helps a genuinely
// cold note (first open this session, or the 4th+ large note visited, or any
// edit).
//
// Splitting the source into independent lexer() calls is only safe at a point
// marked's own grammar treats as an unconditional block boundary regardless of
// what came before or after — a blank line is NOT always that (a blank line
// inside a loose list or between a blockquote's paragraphs continues the same
// block). So a candidate boundary is accepted only when the content line
// immediately before AND immediately after the blank run are both plain,
// unindented, non-list, non-blockquote text — that combination can only occur
// between two blocks that were never going to merge into one. This can miss
// some splits that would in fact have been safe (adjacent lists, for one),
// which only makes a chunk larger; it can never merge or split a block wrongly,
// and a document with no safe points at all degrades to exactly one chunk —
// today's unchunked behaviour.
export function findSafeLexerBoundaries(prepared) {
  const boundaries = [];
  let pos = 0;
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let blankRunStart = -1;
  let prevLineSafe = false;
  const isFenceLine = (line) => line.match(/^ {0,3}(`{3,}|~{3,})/);
  const isUnsafeStart = (line) =>
    /^\s/.test(line) // indented: list continuation or indented code
    || /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/.test(line) // list marker
    || /^ {0,3}>/.test(line); // blockquote marker

  const lines = prepared.split("\n");
  lines.forEach((line, i) => {
    const isLast = i === lines.length - 1;
    const fenceMatch = isFenceLine(line);
    if (inFence) {
      if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen) inFence = false;
      prevLineSafe = false;
      blankRunStart = -1;
    } else if (fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      prevLineSafe = false;
      blankRunStart = -1;
    } else if (line.trim() === "") {
      if (blankRunStart === -1) blankRunStart = pos;
    } else {
      if (blankRunStart !== -1) {
        // The cut lands at the START OF THIS LINE — after the full blank
        // run, not at its start. Cutting mid-blank-run instead (right after
        // the previous block's own line break) leaves the LEFT slice ending
        // in a single trailing "\n" with nothing following it; lexed on its
        // own, marked has no next block to delimit that newline against and
        // folds it into the preceding block's `.raw`, which the same text
        // would NOT carry in one unchunked call. Cutting after the blank run
        // instead gives the left slice its own trailing blank line — the same
        // shape marked already treats as an empty "space" token it discards —
        // and starts the right slice clean, exactly like the confirmed
        // scripted-diff check in verify-chunked-lexer.cjs requires.
        if (prevLineSafe && !isUnsafeStart(line)) boundaries.push(pos);
        blankRunStart = -1;
      }
      prevLineSafe = !isUnsafeStart(line);
    }
    pos += line.length + (isLast ? 0 : 1);
  });
  return boundaries;
}

// Below this, renderMarkdown's parse stays exactly as it is today — one
// unyielded synchronous pass. Only a note at least this large routes through
// splitPreparedBlocksChunked below, so an ordinary note's behaviour and
// performance are untouched.
export const NOTES_PARSE_CHUNK_MIN_CHARS = 200_000;

// Roughly the char count the streaming comment above measures at ~16KB/ms —
// one chunk costs about the same as one RENDER_BATCH_BUDGET_MS frame.
export const LEXER_CHUNK_TARGET_CHARS = 200_000;

// Same contract as splitPreparedBlocks, but lexes in chunks with a yield
// between them so a huge note stops owning the main thread for one long burst.
// `sequenceOk` is checked after every yield — a superseded render (a note
// switch mid-parse) abandons rather than finishing work nobody will see, the
// same discipline the streamed DOM build already uses further down this file.
export async function splitPreparedBlocksChunked(prepared, sequenceOk = () => true) {
  const safe = findSafeLexerBoundaries(prepared);
  const cuts = [];
  let start = 0;
  for (const at of safe) {
    if (at - start >= LEXER_CHUNK_TARGET_CHARS) {
      cuts.push([start, at]);
      start = at;
    }
  }
  cuts.push([start, prepared.length]);

  const blocks = [];
  const combinedLinks = Object.create(null);
  for (let i = 0; i < cuts.length; i += 1) {
    const [from, to] = cuts[i];
    let tokens;
    try {
      tokens = marked.lexer(prepared.slice(from, to));
    } catch (error) {
      return null;
    }
    for (const token of tokens) {
      if (token.type === "space") continue;
      if (typeof token.raw !== "string" || !token.raw.trim()) continue;
      blocks.push(token.raw);
    }
    // First-occurrence-wins, matching marked's own within-a-call precedence
    // for a duplicate link-reference label (confirmed by reading the vendored
    // lexer), so a label split across chunks resolves exactly as it would in
    // one unchunked call.
    for (const [label, link] of Object.entries(tokens.links || {})) {
      if (!(label in combinedLinks)) combinedLinks[label] = link;
    }
    if (i < cuts.length - 1) {
      await yieldToEventLoop();
      if (!sequenceOk()) return null;
    }
  }
  return blocks.length ? { blocks, prelude: definitionPrelude(combinedLinks) } : null;
}

// A marker that survives sanitisation, so every changed block can be parsed and
// sanitized in ONE pass and then split back into per-block HTML.
export const BLOCK_BREAK_HTML = '\n<hr data-recall-block-break="1">\n';

export const BLOCK_BREAK_RE = /<hr\b[^>]*\bdata-recall-block-break\b[^>]*>/;

export function renderPreparedBlocks(sources, prelude = "") {
  // Same reasoning as safeHtmlFromPrepared, which is where each block lands on
  // this path: without the libraries, render the source rather than throw.
  if (!markdownLibrariesReady()) return sources.map((source) => safeHtmlFromPrepared(source));
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

// ── Per-chunk height, measured ahead of the reader rather than guessed ─────
//
// --notes-chunk-estimate (measureNotesBlockEstimate above) is ONE number for
// the whole note — the per-block average scaled up by NOTES_CHUNK_SIZE — and a
// chunk's real content very often isn't average. A chapter of short list items
// next to a chapter of long paragraphs and fenced code differ by 10x in actual
// height, so applying the note-wide figure to both means whichever one the
// reader reaches first replaces a wrong placeholder with its real size in one
// jump. Measured on a 2,490-block note alternating dense/sparse chapters: 30
// jumps over one scroll-through, up to 1,462px each — every one of them a
// visible lurch of the page, which is what a highlight drag through a big note
// feels like ("shaking") when the browser auto-scrolls it past a chunk
// boundary mid-selection.
//
// The fix takes the same shape as the lookahead diagrams and tables already
// get (runNearViewportAndDefer / DEFERRED_WORK_MARGIN): measure each chunk for
// real, but only once it is close enough that the reader will reach it soon —
// not on cold render, where forcing every chunk to lay out is exactly the
// O(document) cost chunking exists to avoid.
//
// It runs through its OWN observer rather than the shared deferred-work one,
// though, because that shared queue only ever drains on an idle callback —
// right for mermaid/table work, which can cost real milliseconds and must
// never run inside a scroll-driven callback, wrong here, where the whole job
// is one forced layout and one property read. Routing it through the idle
// queue stacked up to 250ms of drain latency (headless Chrome never reports a
// genuinely idle period under a scripted scroll, so every drain sat at the
// timeout floor) ON TOP of the runway, and a fast drag-to-select auto-scroll
// covers 1,200px well inside that: measured half the chunks in a 63-chunk note
// still landing on the guess by the time the scroll reached them. Reading
// straight off the intersection entry removes that stacked delay — the
// runway is the only lead time this has left to work with, so it needs all of it.
export const measuredChunkEstimates = new WeakSet();

// Force `chunk` to lay out, read its ACTUAL height (not a sample — the forced
// layout already paid for all 40 blocks, so summing them via offsetHeight is
// free), and pin that as its own contain-intrinsic-size. From then on this
// specific chunk's placeholder is exact, not a note-wide guess, so the browser
// never has anything to correct when it later skips and re-shows it.
//
// Deliberately once per chunk, same as measureNotesBlockEstimate: a mid-scroll
// revision would itself be the jump this exists to prevent. An edit inside an
// already-measured chunk can leave its pinned size stale — accepted for the
// same reason the note-wide estimate accepts it (see the comment there): being
// exactly right before the reader gets there matters far more than staying
// exactly right forever, and the wrapper is rebuilt (a fresh, unmeasured
// element) whenever the edit is big enough to change chunk membership at all.
export function measureNotesChunkEstimate(chunk) {
  if (measuredChunkEstimates.has(chunk)) return;
  measuredChunkEstimates.add(chunk);
  const had = chunk.style.contentVisibility;
  chunk.style.contentVisibility = "visible";
  const height = chunk.offsetHeight;
  if (had) chunk.style.contentVisibility = had;
  else chunk.style.removeProperty("content-visibility");
  if (height > 0) chunk.style.setProperty("contain-intrinsic-size", `auto ${height}px`);
}

// One observer per scroll root, same memoization shape as deferredWorkObserver
// — a fresh IntersectionObserver per call would mean every finalize pass (one
// per render, so every edit) re-registers the SAME chunks against a NEW
// observer, and the old one leaks (it holds a strong reference to every target
// it was ever given, same trap documented on runNearViewportAndDefer).
export const notesChunkEstimateObservers = new Map();

export function notesChunkEstimateObserver(root) {
  const existing = notesChunkEstimateObservers.get(root);
  if (existing) return existing;
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        // One-shot: measureNotesChunkEstimate is idempotent anyway (the WeakSet
        // guards it), but leaving a measured chunk under observation would mean
        // every scroll tick re-delivers an entry for it forever.
        observer.unobserve(entry.target);
        measureNotesChunkEstimate(entry.target);
      });
    },
    { root, rootMargin: `${DEFERRED_WORK_MARGIN}px 0px` }
  );
  notesChunkEstimateObservers.set(root, observer);
  return observer;
}

// Drops the observer for `root` outright rather than unobserving one target at
// a time — called when the note under it is replaced wholesale, where every
// currently-watched chunk is about to be detached anyway. Mirrors
// releaseDeferredWork, and is called from the same place (renderNotesView).
export function releaseNotesChunkEstimateObserver(root) {
  const observer = notesChunkEstimateObservers.get(root);
  if (observer) {
    observer.disconnect();
    notesChunkEstimateObservers.delete(root);
  }
}

// Registers every not-yet-measured chunk in `container`. A chunk already
// intersecting the runway gets its entry (and so its measurement) on the very
// next microtask — there is no separate "near" path to write, the observer's
// own initial callback IS it.
export function scheduleNotesChunkEstimates(container) {
  if (container !== el.notesView || !isChunkedSurface(container)) return;
  if (typeof IntersectionObserver !== "function") return;
  const observer = notesChunkEstimateObserver(container);
  Array.from(container.querySelectorAll(`:scope > .${NOTES_CHUNK_CLASS}`))
    .filter((chunk) => !measuredChunkEstimates.has(chunk))
    .forEach((chunk) => observer.observe(chunk));
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
  if (container !== el.notesView || !blockCount) return false;
  // Paged mode ALWAYS wraps, at any size, because there the wrapper is what
  // makes one chapter showable on its own — see notesChapterBoundaries. It used
  // to be the opposite (never wrap when paged), which is why paged mode had to
  // lay out the entire book and why it refused above 250,000 characters.
  if (container.classList.contains("is-paged")) return true;
  return blockCount >= NOTES_CHUNK_MIN_BLOCKS;
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
  // Regrouped even when the answer to "should this be chunked" is unchanged:
  // going from continuous to paged keeps wrapping but changes WHAT a wrapper
  // is, from a run of forty blocks to a whole chapter.
  if (want === isChunkedSurface(container) && !container.classList.contains("is-paged")) return;
  if (want) rechunkRenderedBlocks(container, blocks.map((node) => [node]), notesChunkBoundaries(blocks.length));
  else container.replaceChildren(...blocks);
}

// Where a chunk must start. Paged mode chapters; continuous mode has no opinion
// and lets the fixed run size decide.
export function notesChunkBoundaries(blockCount) {
  if (!el.notesView?.classList.contains("is-paged")) return null;
  const chapters = chapterIndexFor(state.notes || "");
  const starts = new Set();
  chapters.forEach((chapter) => {
    if (chapter.blockStart < blockCount) starts.add(chapter.blockStart);
  });
  return starts.size ? starts : null;
}

// ── Why the existing chunk ELEMENTS are reused ─────────────────────────────
//
// `content-visibility: auto` remembers the size a box last laid out at, and
// that memory belongs to the ELEMENT. Building a fresh set of wrappers and
// calling container.replaceChildren() on them — which is what this did — threw
// that memory away for every off-screen chunk in the note, so each one snapped
// back to the flat `contain-intrinsic-size` estimate. On a 4MB note that is
// hundreds of thousands of pixels of document height changing in one frame,
// under a reader whose scrollTop suddenly points somewhere else entirely.
//
// It happened on EVERY same-note re-render: making a highlight on a long note
// went through here, and settleNotesPin was then left trying to claw back a
// displacement that the repaint itself had just invented. That is the "abrupt
// and unintended page jump" on a big note.
//
// So the wrappers are kept and only their CONTENTS are re-homed. Blocks that
// are already in the right chunk in the right order are not touched at all,
// which is the overwhelmingly common case (one edited block out of thousands).
// `boundaries` is an optional Set of BLOCK INDEXES at which a new chunk must
// begin. Continuous mode passes nothing and gets fixed runs of NOTES_CHUNK_SIZE;
// paged mode passes its chapter starts, so one chunk is exactly one chapter and
// showing a chapter is a CSS class rather than a re-render.
export function rechunkRenderedBlocks(container, groups, boundaries = null) {
  // The chunk each group belongs to, decided first so the walk below can be a
  // straight comparison against what is already there.
  const plan = [];
  let filled = 0;
  let index = -1;
  let soloOpen = false;
  groups.forEach((nodes, blockIndex) => {
    if (!nodes || !nodes.length) return;
    const solo = nodes.some(blockWantsOwnChunk);
    // With explicit boundaries the size cap does not apply: a chapter is one
    // chunk however many blocks it holds, and splitting it would put half of it
    // behind `display: none`.
    const forced = boundaries ? boundaries.has(blockIndex) : (filled >= NOTES_CHUNK_SIZE || solo || soloOpen);
    if (index === -1 || forced) {
      index += 1;
      filled = 0;
    }
    plan.push({ nodes, index, solo: boundaries ? false : solo });
    filled += 1;
    // A block that had to stand alone must not collect neighbours after it.
    soloOpen = solo;
  });

  const wanted = index + 1;
  const existing = Array.from(container.children).filter((node) => node.classList?.contains(NOTES_CHUNK_CLASS));
  const chunks = [];
  for (let i = 0; i < wanted; i += 1) {
    let chunk = existing[i];
    if (!chunk) {
      chunk = document.createElement("div");
      chunk.className = NOTES_CHUNK_CLASS;
      container.appendChild(chunk);
    }
    chunks.push(chunk);
  }
  // Anything left over from a shorter note. Removed rather than emptied so the
  // container's children stay exactly the chunk list.
  for (let i = wanted; i < existing.length; i += 1) existing[i].remove();
  // Any stray child that is not a chunk (a mode flip left blocks at top level).
  Array.from(container.children).forEach((node) => {
    if (!node.classList?.contains(NOTES_CHUNK_CLASS)) node.remove();
  });
  // Order the chunks themselves, which a fresh append may have got wrong.
  chunks.forEach((chunk, i) => {
    if (container.children[i] !== chunk) container.insertBefore(chunk, container.children[i] || null);
  });

  // ── Re-home with appendChild, and NO sibling cursors ─────────────────────
  //
  // The cursor walk used further down for the unchunked case cannot be lifted
  // here, and trying to do so is what broke every note over 2,000 blocks. That
  // walk is correct only because it has ONE container: hold a `firstChild`
  // cursor per chunk and the first block that moves from chunk A to chunk B is
  // detached from A by B's insertBefore — so A's cursor now points at a node
  // that is no longer A's child, and the cleanup pass throws NotFoundError.
  //
  // appendChild in plan order has no such state. It moves a node out of
  // wherever it was, and the destination order falls out of the call order.
  // This is exactly what the original code did; the only thing that changed is
  // that the wrappers above are reused instead of rebuilt.
  const solos = new Array(wanted).fill(false);
  const wantedNodes = [];
  for (let i = 0; i < wanted; i += 1) wantedNodes.push([]);
  plan.forEach(({ nodes, index: at, solo }) => {
    if (solo) solos[at] = true;
    nodes.forEach((node) => wantedNodes[at].push(node));
  });

  // ── A chunk that is already right is not touched ─────────────────────────
  //
  // Everything below moves nodes with appendChild, which moves a node even when
  // it is already exactly where it should be — and that is a detach plus an
  // insert, invalidating the chunk's layout, for every block in the note on
  // every render. An edit reuses the DOM of every block it did not change (see
  // patchRenderedBlocks), so on a book that was ~18,000 pointless DOM moves to
  // relocate one paragraph: measured as roughly half the 232ms a single
  // highlight spent on the main thread.
  //
  // Comparing first is safe in a way that a per-chunk cursor is not (see the
  // note below): a chunk whose children ALREADY equal its planned list has, by
  // definition, nothing planned for another chunk inside it and nothing
  // unclaimed to sweep out — every node lives in exactly one parent. So it can
  // be skipped whole, and the chunks that genuinely changed take the original
  // path unchanged.
  const chunkAlreadyHolds = (chunk, want) => {
    const children = chunk.childNodes;
    if (children.length !== want.length) return false;
    for (let i = 0; i < want.length; i += 1) if (children[i] !== want[i]) return false;
    return true;
  };

  const planned = new Set();
  const stale = [];
  chunks.forEach((chunk, at) => {
    if (chunkAlreadyHolds(chunk, wantedNodes[at])) return;
    stale.push(at);
    wantedNodes[at].forEach((node) => planned.add(node));
  });

  stale.forEach((at) => {
    const chunk = chunks[at];
    wantedNodes[at].forEach((node) => chunk.appendChild(node));
  });
  // Anything still sitting in a chunk that no block claimed never made it into
  // the new document. Tested against the whole plan, not against one chunk's
  // remainder, so a node that moved between chunks is never mistaken for a
  // leftover.
  stale.forEach((at) => {
    const chunk = chunks[at];
    Array.from(chunk.childNodes).forEach((node) => {
      if (!planned.has(node)) chunk.removeChild(node);
    });
  });
  chunks.forEach((chunk, i) => chunk.classList.toggle("is-uncontained", solos[i]));
}

// ── Streaming the first render ─────────────────────────────────────────────
//
// A cold render of a book is one synchronous burst, and that burst is what makes
// opening a large note feel broken. Measured on a 2MB / 18,061-block note:
// marked.parse per block plus one DOMPurify pass is 323ms, the lexer another
// 125ms, and the whole renderNotesView 884ms — during which the tab answers
// nothing. A long press lands inside that and is classified as a scroll, which
// is why selection "needs pressing over and over" on a big note.
//
// So a cold render is done in batches with a yield between them. Blocks are
// appended in DOCUMENT ORDER, so what appears first is the top of the note and
// content only ever arrives BELOW what is already on screen — never a blank gap
// above the viewport, which is what made the old placeholder + IntersectionObserver
// attempt jitter (see the note in patchRenderedBlocks; do not reintroduce that).
//
// Only for a cold render of a big note. A warm re-render — an edit, a highlight,
// the raw↔rendered toggle — reuses nearly every block and its placement walk is
// already fast; routing that through here would add yields to something that is
// imperceptible anyway, and would make an edit visibly repaint.
export const RENDER_BATCH_BUDGET_MS = 16;

export const RENDER_STREAM_MIN_BLOCKS = 400;

// How many freshly built nodes are enhanced per frame. Much bigger than a build
// batch: enhancement is far cheaper per node, and each slice costs a whole frame
// to yield. At 600 an 18,000-block note spent thirty frames — half a second — of
// pure waiting and the full render went from 1.0s to 2.4s for no gain the reader
// could see. Sized so a very large note is a handful of slices, not dozens.
export const ENHANCE_BATCH_BLOCKS = 3000;

// Yields in a way that actually lets the browser DRAW.
//
// scheduler.yield() was the obvious choice and is the wrong one here: its
// continuation is prioritised above timers and rendering, so the batches ran
// back to back and nothing was painted until the whole note was built —
// measured as "time to first visible block: never, until the end". It keeps a
// task responsive to input, which is not the same as letting the page show
// progress.
//
// A frame callback is the thing that guarantees a paint opportunity. The
// timeout is a floor, not a preference: requestAnimationFrame does not fire in
// a background tab, and without it a note opened in a tab the reader then
// switched away from would stop rendering half-built.
export const RENDER_FRAME_TIMEOUT_MS = 32;

export function yieldToEventLoop() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    requestAnimationFrame(done);
    setTimeout(done, RENDER_FRAME_TIMEOUT_MS);
  });
}

// Build every block of a cold render, appending as it goes. Returns the node
// groups, in block order, so the caller can record them in the cache.
export async function streamRenderedBlocks(container, blocks, prelude, sequenceOk, prebuilt = null) {
  // `prebuilt` carries the node groups the cache could reuse, so a big edit
  // streams only what actually changed while still placing the untouched blocks
  // in order. Without it the condition below had to demand that NOTHING was
  // reusable, which almost never holds — two notes from the same source share
  // their headings and list blocks — and the streaming path went untaken on
  // exactly the renders it was written for.
  const groups = prebuilt ? prebuilt.slice() : new Array(blocks.length);
  const chunked = shouldChunkRenderedBlocks(container, blocks.length);
  const boundaries = chunked ? notesChunkBoundaries(blocks.length) : null;
  container.replaceChildren();

  let chunk = null;
  let filled = 0;
  const place = (blockIndex, nodes) => {
    if (!chunked) {
      nodes.forEach((node) => container.appendChild(node));
      return;
    }
    const forced = boundaries ? boundaries.has(blockIndex) : filled >= NOTES_CHUNK_SIZE;
    if (!chunk || forced) {
      chunk = document.createElement("div");
      chunk.className = NOTES_CHUNK_CLASS;
      container.appendChild(chunk);
      filled = 0;
    }
    nodes.forEach((node) => chunk.appendChild(node));
    filled += 1;
  };

  let at = 0;
  while (at < blocks.length) {
    const started = performance.now();
    // One batch is however many blocks fit in the budget, re-measured every
    // time: block cost varies by two orders of magnitude between a one-line
    // paragraph and a big table, so a fixed batch size is either too slow to
    // yield or too small to be efficient.
    let end = at;
    do {
      end = Math.min(blocks.length, end + 24);
      // Only the blocks with no reusable DOM are parsed; the rest are already
      // built and just need placing in order.
      const buildAt = [];
      for (let i = at; i < end; i += 1) if (!groups[i]) buildAt.push(i);
      if (buildAt.length) {
        const parts = renderPreparedBlocks(buildAt.map((i) => blocks[i]), prelude);
        buildAt.forEach((i, n) => { groups[i] = nodesFromHtml(parts[n] ?? ""); });
      }
      for (let i = at; i < end; i += 1) place(i, groups[i] || []);
      at = end;
    } while (at < blocks.length && performance.now() - started < RENDER_BATCH_BUDGET_MS);

    if (at < blocks.length) {
      await yieldToEventLoop();
      // A newer render started while this one was yielding; its own
      // replaceChildren has already taken the container.
      if (!sequenceOk()) return null;
    }
  }
  return groups;
}

// Rebuilds `container`'s children to match `blocks`, reusing the DOM of every
// block whose source is unchanged. Returns the new block list plus the nodes
// that were freshly built, which are the only ones needing enhancement.
export async function patchRenderedBlocks(container, blocks, prelude, cached, sequenceOk = () => true) {
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

  // Cold and large: stream it, so the top of the note is on screen in a few
  // milliseconds instead of after the whole book has been parsed.
  //
  // The test is "nothing was reusable", not "there was no cache entry". A stale
  // entry — from another note, or from before a theme change bumped the render
  // generation — is an object that exists and reuses nothing, and testing for
  // its presence sent every genuinely cold render of a book down the
  // synchronous path. Measured: the streaming path was never once taken by a
  // reader opening a note.
  if (missing.length >= RENDER_STREAM_MIN_BLOCKS) {
    const streamed = await streamRenderedBlocks(container, blocks, prelude, sequenceOk, groups);
    if (!streamed) return null;
    // Only the newly built blocks are `fresh`: enhanceRenderedMarkdown re-runs
    // KaTeX, diagram deferral and code highlighting over whatever it is handed,
    // and handing it a reused block would redo work whose result is already in
    // the DOM.
    const built = new Set(missing);
    const fresh = [];
    streamed.forEach((nodes, index) => {
      if (built.has(index)) nodes.forEach((node) => fresh.push(node));
    });
    return { blocks: blocks.map((key, index) => ({ key, nodes: streamed[index] })), fresh };
  }

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
    rechunkRenderedBlocks(container, groups, notesChunkBoundaries(groups.length));
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
  const sequenceOk = () => renderSequence.get(container) === sequence;

  // A switch back to a recently-open note: preprocessSpecialBlocks + the
  // marked.lexer split are a single unyielded synchronous pass (measured at
  // 100-300ms+ on a large note), and renderedBlockCache above only remembers
  // the CURRENT note — a note switch away and back re-paid that pass in full
  // even though this note's markdown hadn't changed at all. Reuse the parse
  // when the identity and the exact markdown both match; the rebuild below
  // still goes through the normal (already yielded/chunked) patch/stream path.
  const notesKey = container === el.notesView ? currentNotesParseKey() : null;
  const parseHistory = notesKey ? notesParseHistory.get(notesKey) : null;
  const reuseParse = parseHistory
    && parseHistory.generation === renderGeneration
    && parseHistory.source === displayMarkdown
    ? parseHistory
    : null;

  // A genuinely cold open of a note this large has no cache to fall back on,
  // and preprocessSpecialBlocks + marked.lexer over the whole source is the
  // single longest unbroken synchronous span in the app (see the streaming
  // comment above streamRenderedBlocks). Yielding around it here is the fix —
  // everything below this point was already chunked. Below the threshold, or
  // on a parse-history hit, this is byte-for-byte today's code path.
  const hugeCold = !reuseParse && container === el.notesView && displayMarkdown.length >= NOTES_PARSE_CHUNK_MIN_CHARS;

  let prepared;
  let split;
  if (reuseParse) {
    prepared = reuseParse.prepared;
    split = reuseParse.split;
  } else if (hugeCold) {
    await yieldToEventLoop();
    if (!sequenceOk()) return;
    prepared = preprocessSpecialBlocks(displayMarkdown);
    await yieldToEventLoop();
    if (!sequenceOk()) return;
    split = await splitPreparedBlocksChunked(prepared, sequenceOk);
    if (!sequenceOk()) return;
  } else {
    prepared = preprocessSpecialBlocks(displayMarkdown);
    split = cacheable ? splitPreparedBlocks(prepared) : null;
  }
  if (notesKey && split) {
    rememberNotesParseHistory(notesKey, { generation: renderGeneration, source: displayMarkdown, prepared, split });
  }
  let roots = null;
  if (split) {
    // Every block is parsed behind the document's link reference definitions, so
    // a change to those changes what any block could render to: start over.
    const reusable = cached && cached.prelude === split.prelude ? cached : null;
    // A freshly appended block has had no layout pass at all yet — contained or
    // not, establishing its box is real work — so while a big note is streaming
    // in, ANY forced layout read anywhere in the app (even of an unrelated
    // fixed-size element — see readChromeHeights in ui/chrome.js) flushes that
    // backlog synchronously wherever it happens to land, which is what makes an
    // unrelated button feel like it hung. Flagged here so those callers can
    // defer themselves a frame instead of forcing it mid-stream.
    const tracksStream = container === el.notesView && split.blocks.length >= RENDER_STREAM_MIN_BLOCKS;
    if (tracksStream) notesStreamBusyCount += 1;
    // Awaited: a cold render of a big note is streamed in batches with a yield
    // between them, so this can span many frames. `sequenceOk` is how it knows
    // to abandon a run whose container a newer render has already taken.
    // try/finally: a superseded or errored stream must still release its count,
    // or a caller that never reaches "if (!patched) return" below leaves the
    // flag stuck busy for the rest of the session.
    let patched;
    try {
      patched = await patchRenderedBlocks(
        container, split.blocks, split.prelude, reusable,
        () => renderSequence.get(container) === sequence
      );
    } finally {
      if (tracksStream) notesStreamBusyCount = Math.max(0, notesStreamBusyCount - 1);
    }
    if (!patched) return; // superseded mid-stream
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

  // Sliced for a big note, for the same reason the build is: enhancement runs
  // KaTeX over every fresh node and several document-wide queries, which on
  // 18,000 blocks is one ~300ms task landing immediately after the reader can
  // already see the text. Slicing lets those frames paint and keeps input alive.
  if (roots && roots.length >= RENDER_STREAM_MIN_BLOCKS) {
    for (let i = 0; i < roots.length; i += ENHANCE_BATCH_BLOCKS) {
      await enhanceRenderedMarkdown(container, roots.slice(i, i + ENHANCE_BATCH_BLOCKS));
      if (renderSequence.get(container) !== sequence) return;
      if (i + ENHANCE_BATCH_BLOCKS < roots.length) await yieldToEventLoop();
    }
  } else {
    await enhanceRenderedMarkdown(container, roots);
  }
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
  // Synchronous for everything except a big note, where the tail is the
  // block-height estimate — a forced layout of a 48-block sample, measured at
  // 126ms on an 18,000-block note — landing right after the reader can already
  // see and scroll the text. It is not needed for the note to be readable, so
  // on a large note it waits for an idle moment instead of holding the thread.
  //
  // It stays sync below the threshold, and always for the card faces and the
  // print/export roots: exportPdf reads the image grips immediately after this
  // resolves, and those are small surfaces where the tail costs nothing.
  const bigNotes = container === el.notesView && (split?.blocks.length || 0) >= RENDER_STREAM_MIN_BLOCKS;
  scheduleSurfaceFinalize(container, { sync: !bigNotes });
}
