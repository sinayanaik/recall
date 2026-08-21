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
import { bindNotesHeadingElements, markNotesTocDirty, refreshNotesTocAvailability } from "../notes/toc.js?v=__BUILD__";
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
  // ── Not while part of the note is unbuilt ────────────────────────────────
  //
  // Both of these bind by POSITION: they walk the note's image/diagram tokens
  // in source order and the view's shells in document order, pairing them off.
  // On a viewport-built note the shells present are a subset of the tokens, so
  // the walk desynchronises — and what it writes is `shell.dataset.tokenIndex`,
  // which is the index a resize drag later rewrites in the markdown. A wrong
  // index there would resize the wrong image, so the pass simply does not run
  // until the whole note is real. Reading is unaffected: the width of a resized
  // image travels in its own <img style> through the markdown (see
  // commitImageWidth), and diagram zoom is bound per element by enhance.js.
  // Anything that needs the grips (an export, a print) materializes first.
  if (surface && !notesLazyPending(container)) {
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

// Is this lexer token one of the BLOCKS the cache is keyed by?
//
// One definition, shared by all three splitters (this one, the chunked one, and
// the window lexer incrementalSplitPreparedBlocks uses). That is not tidiness:
// the incremental splitter proves itself by comparing one window lex against
// another, so a filter that drifted between the copies would produce block
// arrays that disagree in a way its own guard is blind to. Same reasoning as
// FENCE_PATTERN_SOURCE in render/preprocess.js.
export function isBlockToken(token) {
  if (!token || token.type === "space") return false;
  return typeof token.raw === "string" && Boolean(token.raw.trim());
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
    if (!isBlockToken(token)) continue;
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
        // and starts the right slice clean.
        //
        // This used to cite a scripted diff named verify-chunked-lexer.cjs, which
        // is not in the tree and is in no commit — a correctness argument resting
        // on a file nobody could run. The property is asserted for real now, in
        // tools/incremental-split-check.mjs: lexing a slice that runs from one
        // block's start to another block's start gives back exactly the blocks in
        // between. That is what this rule claims, and the incremental splitter
        // further down leans on the same fact.
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
      if (!isBlockToken(token)) continue;
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

// ── Re-splitting only what an edit actually changed ────────────────────────
//
// Every in-place edit to the open note — highlight, cloze, erase, recolour, the
// rendered formatting toolbar — comes back through renderMarkdown, and until
// this existed the whole document was re-lexed before a single block could be
// diffed. Measured on a 2.4MB / 18,000-block note: marked.lexer is 159ms, and
// past NOTES_PARSE_CHUNK_MIN_CHARS it is not even one long task but twelve
// chunks with eleven yields between them, so an edit cost ~11 frames of wall
// clock before anything could repaint. That is the largest single cost on the
// path between tapping "highlight" and seeing the mark, and it is the reason
// the repaint had so much settling left to do afterwards.
//
// The block array of the previous version of this note is already kept
// (notesParseHistory), and an edit changes a paragraph. So: diff the two
// PREPARED strings, re-lex a window of a few KB around the change, and splice.
//
// ── Why the diff is taken on `prepared` and not on the markdown ────────────
//
// Three things in front of the lexer are document-wide, and reasoning about
// each of them separately is how this gets subtly wrong:
//
//   • promoteNotesHeadings (render/enhance.js) computes the shallowest heading
//     level in the whole note and restripes EVERY heading by that amount, so
//     typing one "# " can rewrite headings a thousand blocks away.
//   • fencePattern() in render/preprocess.js pairs ``` delimiters greedily left
//     to right, so one unmatched fence re-pairs every fence after it.
//   • protectInline / protectMath (render/inline.js, render/math.js) scan an
//     entire inter-fence segment left to right, so an unbalanced backtick or
//     "{{" shifts every decision after it in that segment.
//
// Diffing their OUTPUT collapses all three into one measurable fact: a change
// that was not local produces a diff that is not local, and the window bound
// below rejects it without anyone having to enumerate the cases. What preprocess
// notably does NOT have is any global counter or placeholder table — cloze spans,
// math nodes and diagram divs all carry only their own content, and equation
// numbers are a CSS counter applied to the rendered DOM afterwards — so there is
// no renumbering to chase.
//
// Verified against the vendored marked 14.1.2. The junction argument below is a
// claim about that lexer's merge rules; tools/incremental-split-check.mjs is
// what pins it to the copy on disk.

// How many unchanged blocks either side of the change are re-lexed as well.
// Zero is unusable — the margin blocks would BE the changed blocks, so the
// certificate can never be clean. One works; two is the first value where a
// margin block can be disturbed and there is still a clean one behind it, and it
// costs a couple of KB of lexing.
export const INCREMENTAL_SPLIT_MARGIN_BLOCKS = 2;

// The work is bounded BEFORE it starts rather than discovered half way through.
// At the ~16KB/ms the chunked lexer above measures, two lexes of 64KB is ~8ms —
// inside one RENDER_BATCH_BUDGET_MS frame. A bigger change than this (a paste,
// a document-wide restripe) falls to the full path, which is what you want at
// that size anyway.
export const INCREMENTAL_SPLIT_MAX_WINDOW_CHARS = 64_000;

export const INCREMENTAL_SPLIT_MAX_WINDOW_BLOCKS = 200;

// Under this the full lex is already under a frame (~6ms at 100KB), so there is
// nothing to win and the simpler path is the better one. Lowering it is a
// one-constant change that tools/incremental-split-check.mjs already covers.
export const NOTES_INCREMENTAL_SPLIT_MIN_CHARS = 100_000;

// How many edits took the patched path and how many fell through to a full
// re-lex. Counters rather than a boolean because the failure this exists to
// catch is not "it broke" but "it silently stopped happening": a splitter that
// always refuses satisfies every correctness property perfectly and delivers
// nothing, which is exactly what the note above patchRenderedBlocks records for
// the streaming path ("measured: the streaming path was never once taken by a
// reader opening a note"). tools/interaction-scale-check.mjs asserts these move.
export let notesIncrementalSplits = 0;

export let notesFullSplits = 0;

export function countNotesSplit(incremental) {
  if (incremental) notesIncrementalSplits += 1;
  else notesFullSplits += 1;
}

// Read them through a call, not through the bindings. A checker that copies
// module exports into a plain object once at setup — which is exactly what
// tools/interaction-scale-check.mjs does — snapshots a `let` by VALUE, so the
// counters would read 0 forever and the assertion would quietly measure nothing.
export function notesSplitCounts() {
  return { incremental: notesIncrementalSplits, full: notesFullSplits };
}

// Compare in slices before comparing character by character. The naive loop is
// 16ms on a 2.4MB note — an eighth of what this whole mechanism saves — because
// it is a property read per character. A slice comparison is a memcmp after one
// allocation; 4KB steps take the same diff to 1ms.
export const AFFIX_SCAN_STEP_CHARS = 4096;

// Where two strings stop agreeing, from both ends:
//   before[head, tailBefore) was replaced by after[head, tailAfter)
// The suffix scan is bounded so the two halves can never cross.
//
// A `head` that lands between the halves of a surrogate pair is harmless:
// nothing is ever sliced at `head`, only at block starts, which are token
// boundaries and therefore never mid-character.
export function preparedEditRange(before, after) {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head + AFFIX_SCAN_STEP_CHARS <= limit
      && before.slice(head, head + AFFIX_SCAN_STEP_CHARS) === after.slice(head, head + AFFIX_SCAN_STEP_CHARS)) {
    head += AFFIX_SCAN_STEP_CHARS;
  }
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  const tailLimit = limit - head;
  while (tail + AFFIX_SCAN_STEP_CHARS <= tailLimit
      && before.slice(before.length - tail - AFFIX_SCAN_STEP_CHARS, before.length - tail)
        === after.slice(after.length - tail - AFFIX_SCAN_STEP_CHARS, after.length - tail)) {
    tail += AFFIX_SCAN_STEP_CHARS;
  }
  while (tail < tailLimit && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return { head, tailBefore: before.length - tail, tailAfter: after.length - tail };
}

// Each block's start offset in `prepared`, in document order.
//
// Every token.raw is an exact contiguous slice of `prepared` and they appear in
// order, so each indexOf from the running cursor scans a handful of characters —
// 2ms for 18,000 blocks on 2.4MB. What sits BETWEEN two blocks is a blank run or
// a link-reference definition (which marked consumes into tokens.links and emits
// no block for), so the starts do not tile the document and the mapping below
// must not assume they do.
//
// Int32Array rather than a plain array: 72KB per history entry instead of ~580KB,
// three entries at a time. Returns null if a raw is not where it must be, which
// is the caller's signal to take the full path.
export function blockStartOffsets(prepared, blocks) {
  const starts = new Int32Array(blocks.length);
  let cursor = 0;
  for (let n = 0; n < blocks.length; n += 1) {
    const at = prepared.indexOf(blocks[n], cursor);
    if (at < 0) return null;
    starts[n] = at;
    cursor = at + blocks[n].length;
  }
  return starts;
}

// The last index whose start is at or before `at`, or -1. `starts` is sorted by
// construction.
export function lastBlockAtOrBefore(starts, at) {
  let lo = 0;
  let hi = starts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= at) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

// One lex of a bounded slice, carrying everything the guards need: the block
// raws, their token TYPES, their offsets within the slice, and the link
// definitions the slice registered.
export function lexWindowBlocks(text) {
  let tokens;
  try {
    tokens = marked.lexer(text);
  } catch (error) {
    return null;
  }
  const blocks = [];
  const types = [];
  const offsets = [];
  let cursor = 0;
  for (const token of tokens) {
    if (!isBlockToken(token)) continue;
    const at = text.indexOf(token.raw, cursor);
    if (at < 0) return null;
    blocks.push(token.raw);
    types.push(token.type);
    offsets.push(at);
    cursor = at + token.raw.length;
  }
  return { blocks, types, offsets, links: tokens.links || {} };
}

// Do two lexes agree about every link-reference definition they saw?
//
// This is the prelude's guard, and comparing the two window lexes is exact where
// a regex over the source text is not. marked absorbs a definition that
// immediately follows a paragraph into that paragraph's raw and never registers
// it — so deleting the paragraph above an UNTOUCHED definition promotes it into
// tokens.links and changes the prelude for the whole document without changing
// the definition's own text. A source-level scan passes that; this does not.
export function sameLinkDefinitions(a, b) {
  const keysA = Object.keys(a || {});
  const keysB = Object.keys(b || {});
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    const left = a[key];
    const right = b[key];
    if (!right) return false;
    if (left?.href !== right?.href || left?.title !== right?.title) return false;
  }
  return true;
}

// Re-split `prepared` by patching `base`'s block array, or null to say "take the
// full path". `base` is a notesParseHistory entry.
//
// ── Why the window is safe ─────────────────────────────────────────────────
//
// The claim is that lex(A + W' + B) equals lex(A) ++ lex(W') ++ lex(B) at block
// level, where A and B are the unchanged head and tail of the document and are
// already known (they are blocks[0..i-1] and blocks[j+1..]). Three certificates
// establish it, and any one of them failing means we refuse rather than guess:
//
//   1. The OLD window reproduces itself. Lexing before.slice(ws, we) must give
//      back exactly blocks[i..j]. That proves, empirically and for this specific
//      window, that ws and we are independent lex points in the old document —
//      that the trailing-newline folding described above findSafeLexerBoundaries
//      did not bite here, that `starts` is aligned, and that no space/code/def/
//      text merge straddles either boundary.
//   2. The head margin is untouched. The first MARGIN blocks of the new window
//      must match the old window's by raw, by TYPE and by OFFSET. Offsets, not
//      just raws, because that is what proves the change did not creep into the
//      margin. Every cross-token merge in marked is a merge into the PREVIOUS
//      token and its tokenizer regexes are anchored at the cursor looking
//      forward — so the decision at the A/window junction has exactly these
//      inputs, and they are unchanged.
//   3. The tail margin is untouched, at the same positions relative to the end
//      of the window (offsets shifted by delta). This is what catches a fence
//      the edit opened and never closed: an unclosed fence runs to the end of
//      the window and swallows the tail margin, so the certificate fails.
//
// Plus the link-definition certificate above, because the prelude is document-
// wide. A and B are byte-identical, the window contributes at the same position
// in document order, and marked's merge is first-occurrence-wins — so identical
// window links means an identical merged prelude, which is why base's prelude is
// reused byte for byte rather than recomputed. (It has to be byte-identical, or
// the `cached.prelude === split.prelude` test below would discard every reusable
// block and undo the whole point.)
export function incrementalSplitPreparedBlocks(base, prepared) {
  try {
    const previous = base?.prepared;
    const blocks = base?.split?.blocks;
    if (typeof previous !== "string" || !Array.isArray(blocks) || !blocks.length) return null;
    if (typeof base.split.prelude !== "string") return null;
    const range = preparedEditRange(previous, prepared);
    if (!range) return null; // identical — reuseParse already handled it

    // Memoized on the history entry, so the O(n) walk is paid once per full
    // parse rather than once per edit. Safe to write onto: it is our own object,
    // and a wrong `starts` cannot slip through — certificate 1 re-derives the
    // window's blocks from `previous` and compares them against the array it is
    // supposed to index.
    const starts = base.starts || (base.starts = blockStartOffsets(previous, blocks));
    if (!starts || starts.length !== blocks.length) return null;

    // The LAST block at or before the change, not the first at or after it, so a
    // change landing in the gap between two blocks — a blank run, or a link
    // definition, which produces no block at all — stays inside the window.
    let i0 = lastBlockAtOrBefore(starts, range.head);
    if (i0 < 0) i0 = 0;
    let j0 = lastBlockAtOrBefore(starts, Math.max(range.head, range.tailBefore - 1));
    if (j0 < i0) j0 = i0;

    const i = Math.max(0, i0 - INCREMENTAL_SPLIT_MARGIN_BLOCKS);
    const j = Math.min(blocks.length - 1, j0 + INCREMENTAL_SPLIT_MARGIN_BLOCKS);
    // Clamping to the document's ends rather than bailing there matters: an edit
    // near the top or bottom of a note is ordinary, and refusing those would send
    // a tenth of all edits back to the full lex for nothing. It is not a
    // weakening — when i is 0 the window starts at offset 0, so there is no left
    // junction to certify at all, and symmetrically at the right.
    const atHead = i === 0;
    const atTail = j === blocks.length - 1;
    const windowStart = atHead ? 0 : starts[i];
    const windowEnd = atTail ? previous.length : starts[j + 1];
    const delta = prepared.length - previous.length;
    const windowEndNew = windowEnd + delta;

    // The change escaped the window, or the arithmetic went backwards. Neither
    // should be reachable; both are cheaper to test than to reason about.
    if (windowStart > range.head || windowEnd < range.tailBefore) return null;
    if (windowEndNew < windowStart) return null;
    if (windowEnd - windowStart > INCREMENTAL_SPLIT_MAX_WINDOW_CHARS) return null;
    if (windowEndNew - windowStart > INCREMENTAL_SPLIT_MAX_WINDOW_CHARS) return null;
    if (j - i + 1 > INCREMENTAL_SPLIT_MAX_WINDOW_BLOCKS) return null;

    const was = lexWindowBlocks(previous.slice(windowStart, windowEnd));
    if (!was || was.blocks.length !== j - i + 1) return null;
    for (let k = 0; k < was.blocks.length; k += 1) {
      if (was.blocks[k] !== blocks[i + k]) return null; // certificate 1
    }

    const now = lexWindowBlocks(prepared.slice(windowStart, windowEndNew));
    if (!now) return null;
    const needHead = atHead ? 0 : INCREMENTAL_SPLIT_MARGIN_BLOCKS;
    const needTail = atTail ? 0 : INCREMENTAL_SPLIT_MARGIN_BLOCKS;
    // Enough blocks for the two margins to be disjoint, or a certificate would
    // be inspecting the same block twice and proving nothing.
    if (now.blocks.length < needHead + needTail) return null;
    for (let k = 0; k < needHead; k += 1) { // certificate 2
      if (now.blocks[k] !== was.blocks[k]) return null;
      if (now.types[k] !== was.types[k]) return null;
      if (now.offsets[k] !== was.offsets[k]) return null;
    }
    for (let k = 0; k < needTail; k += 1) { // certificate 3
      const at = now.blocks.length - 1 - k;
      const from = was.blocks.length - 1 - k;
      if (now.blocks[at] !== was.blocks[from]) return null;
      if (now.types[at] !== was.types[from]) return null;
      if (now.offsets[at] !== was.offsets[from] + delta) return null;
    }
    if (!sameLinkDefinitions(was.links, now.links)) return null;

    const next = blocks.slice(0, i).concat(now.blocks, blocks.slice(j + 1));
    if (!next.length) return null;
    // The new offsets fall out of the work already done — prefix unchanged,
    // window measured against the slice, suffix shifted — so steady-state
    // editing never re-walks the document.
    const nextStarts = new Int32Array(next.length);
    for (let k = 0; k < i; k += 1) nextStarts[k] = starts[k];
    for (let k = 0; k < now.blocks.length; k += 1) nextStarts[i + k] = windowStart + now.offsets[k];
    for (let k = j + 1; k < blocks.length; k += 1) nextStarts[i + now.blocks.length + (k - j - 1)] = starts[k] + delta;
    return { split: { blocks: next, prelude: base.split.prelude }, starts: nextStarts };
  } catch (error) {
    // A throw from the lexer on some edge shape must degrade to a full re-lex,
    // never to a blank note — the same discipline splitPreparedBlocks already
    // applies to its own lex.
    return null;
  }
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
  // A chunk that is ON SCREEN is not being skipped, so its contents already have
  // real geometry and there is nothing to force. Testing that first is not a
  // micro-optimisation: writing `content-visibility` invalidates layout for
  // everything after the chunk, so toggling it on and off again makes the NEXT
  // read a layout of the whole document — the 122ms-per-frame cost that
  // styles/19-notes-chunks.css exists to avoid, paid twice per call.
  //
  // Every caller that matters is asking about a block near the reader: the pin's
  // anchors after an edit (settleNotesPin re-reads them on each settle pass), the
  // reading line, the TOC's active row. So the common case was paying a full
  // document layout to learn something the layout already knew.
  const bounds = container.getBoundingClientRect();
  const box = chunk.getBoundingClientRect();
  if (box.bottom > bounds.top && box.top < bounds.bottom) return read();
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
  // ── Why there is no scrollTop correction here ────────────────────────────
  //
  // Replacing a guessed placeholder with the real height changes the document
  // above the reader whenever the chunk sits above the fold, so the obvious move
  // is to add the difference back onto scrollTop. Measured, that is wrong: the
  // browser's own scroll anchoring already absorbs it, and correcting on top of
  // it double-counts — a 63px drift became a 337px one, in the opposite
  // direction. The numbers came from tools/large-note-selection-check.mjs, which
  // measures where a paragraph sits ON THE GLASS rather than what scrollTop says.
  //
  // What the caller can control is WHICH chunks get measured, and that is where
  // the decision belongs: see pinChunkHeights in src/notes/selection.js, which
  // stays below the fold for exactly this reason.
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
  // Regrouping MOVES the nodes that are there, so a note holding most of its
  // spans back would lose them outright. This is the flip into (or out of)
  // paged mode, which cannot be lazy in the first place — see
  // canRenderNotesLazily — so it is exactly the moment to make the whole note
  // real. Synchronously, and at whatever that costs: it is the cost the paged
  // flip has always paid, and the reader asked for it.
  materializeNotesLazySpansSync(container);
  forgetNotesLazyPlan(container);
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

// ── Heading index, read off the source ────────────────────────────────────
//
// The table of contents used to be discovered by querying the rendered DOM for
// h1..h6, which is only possible while every block of the note is in it. That
// is incompatible with most of a book staying unbuilt, and it was never a good
// arrangement anyway: it made the contents of a note depend on how far its
// render had got, so a big note's drawer was empty or short for as long as the
// render took.
//
// So headings are found in the PREPARED source instead, in one line scan with
// the same fence tracking findSafeLexerBoundaries uses. Prepared rather than
// raw markdown for two reasons: promoteNotesHeadings has already restriped the
// levels there (so `##` really is the level the reader will see), and the
// offsets are directly comparable to the span index above, which is what lets a
// heading know which chunk it lives in before that chunk exists.
//
// tools/viewport-split-check.mjs asserts this scan against marked's own heading
// tokens across every note shape in the corpus.
export const HEADING_ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*?))?[ \t]*$/;

export const HEADING_SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

export const HEADING_QUOTE_RE = /^(?: {0,3}>[ \t]?)+/;

export const HEADING_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

// What the rendered heading's textContent will say, derived from its markdown.
// The inline syntax the renderer strips is stripped here too, so a slug
// computed from this matches the one the DOM used to produce — which matters,
// because those slugs are the anchors [[Note#heading]] links were written
// against.
export function plainHeadingText(raw) {
  return String(raw || "")
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`+/g, "")
    .replace(/(\*\*\*|___|\*\*|__|\*|~~)/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~])/g, "$1")
    .replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (whole, name) => HEADING_ENTITIES[name] ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

// ATX headings may close with their own run of hashes, which is punctuation
// rather than text: `## Title ##` renders as "Title".
export function stripAtxClosing(text) {
  return String(text || "").replace(/(?:^|[ \t])#+[ \t]*$/, "").trim();
}

export function scanPreparedHeadings(prepared) {
  const headings = [];
  const lines = String(prepared || "").split("\n");
  let pos = 0;
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  // The paragraph currently open, which is what a setext underline turns into a
  // heading. Null whenever the previous line cannot start one.
  let paragraph = null;
  const isFenceLine = (line) => line.match(/^ {0,3}(`{3,}|~{3,})/);

  lines.forEach((line, i) => {
    const isLast = i === lines.length - 1;
    const start = pos;
    pos += line.length + (isLast ? 0 : 1);

    const fenceMatch = isFenceLine(line);
    if (inFence) {
      if (fenceMatch && fenceMatch[1][0] === fenceChar && fenceMatch[1].length >= fenceLen) inFence = false;
      paragraph = null;
      return;
    }
    if (fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      paragraph = null;
      return;
    }

    // A heading inside a blockquote still renders as a heading and still
    // belongs in the contents, so the quote markers come off first.
    const quoted = HEADING_QUOTE_RE.exec(line);
    const body = quoted ? line.slice(quoted[0].length) : line;

    if (body.trim() === "") {
      paragraph = null;
      return;
    }

    const atx = HEADING_ATX_RE.exec(body);
    if (atx) {
      const text = plainHeadingText(stripAtxClosing(atx[2] || ""));
      if (text) headings.push({ level: atx[1].length, text, offset: start });
      paragraph = null;
      return;
    }

    const setext = paragraph && HEADING_SETEXT_RE.exec(body);
    if (setext) {
      const text = plainHeadingText(paragraph.lines.join(" "));
      if (text) headings.push({ level: setext[1][0] === "=" ? 1 : 2, text, offset: paragraph.offset });
      paragraph = null;
      return;
    }

    // Four spaces of indent with no paragraph open is indented code, which
    // holds no headings. With one open it is a lazy continuation of it.
    if (!paragraph && /^ {4,}/.test(body)) return;
    if (paragraph) paragraph.lines.push(body);
    else paragraph = { offset: start, lines: [body] };
  });
  return headings;
}

// One scan per note, remembered. buildNotesToc, the availability test on the ☰
// button, a [[Note#heading]] lookup and the render itself all want the same
// answer about the same string.
export let notesHeadingScanSource = null;

export let notesHeadingScanResult = [];

export function notesHeadingScan(prepared) {
  const text = String(prepared || "");
  if (text === notesHeadingScanSource) return notesHeadingScanResult;
  notesHeadingScanResult = scanPreparedHeadings(text);
  notesHeadingScanSource = text;
  return notesHeadingScanResult;
}

// ── The lazy render itself ────────────────────────────────────────────────

export function canRenderNotesLazily(container, prepared) {
  if (container !== el.notesView || !container) return false;
  // Paged mode groups by CHAPTER, and a chapter boundary is a block index that
  // only a full lex can produce. See the header note above.
  if (container.classList.contains("is-paged")) return false;
  if (typeof IntersectionObserver !== "function") return false;
  if (typeof marked === "undefined" || !markdownLibrariesReady()) return false;
  return prepared.length >= NOTES_LAZY_MIN_CHARS;
}

// Returns "rendered" when the note is now on screen lazily, "superseded" when a
// newer render took the container mid-flight, or null to say "not this note —
// take the eager path", which is always safe.
export async function renderNotesLazily(container, prepared, sequenceOk) {
  const existing = notesLazyPlans.get(container);
  // ── The cheap case: an edit to the note already on screen ────────────────
  if (existing && existing.prepared !== prepared && isNotesLazyDom(container, existing)) {
    const patched = patchNotesLazyPlanLocally(container, existing, prepared);
    countNotesLazyPatch(Boolean(patched));
    if (patched) {
      refreshNotesLazyCacheBlocks(container, existing);
      return "rendered";
    }
  }

  const boundaries = findSafeLexerBoundaries(prepared);
  if (!sequenceOk()) return "superseded";
  const spans = planNotesLazySpans(prepared, boundaries);
  // Nothing to defer, or not enough to be worth it: a document with no safe cut
  // in it is one span, which is today's whole-note lex with extra steps, and a
  // note under the chunking threshold is one this was never aimed at.
  if (spans.length < NOTES_LAZY_MIN_SPANS) return null;

  const links = new Array(spans.length).fill(null);
  const candidates = notesLazyDefinitionSpans(prepared, spans);
  const prelude = notesLazyPrelude(prepared, spans, candidates, links);
  if (prelude == null) return null; // too much of the document could hold a definition
  if (!sequenceOk()) return "superseded";
  for (let i = 0; i < links.length; i += 1) if (!links[i]) links[i] = {};

  if (existing && isNotesLazyDom(container, existing)) {
    replanNotesLazySpans(container, existing, prepared, spans, candidates, links, prelude);
  } else {
    const plan = {
      prepared, prelude, spans, candidates, links,
      chunks: [],
      blocks: new Array(spans.length).fill(null),
      groups: new Array(spans.length).fill(null),
      starts: new Array(spans.length).fill(null),
      built: new Uint8Array(spans.length)
    };
    notesLazyPlans.set(container, plan);
    buildNotesLazyChunks(container, plan);
  }
  return "rendered";
}

// Is the DOM still the one this plan describes? A plan is only reusable while
// its own chunks are the container's children — anything else (a paged-mode
// flip, an eager re-render, a different note having taken the surface) means
// starting over.
export function isNotesLazyDom(container, plan) {
  return plan.chunks.length > 0
    && plan.chunks.length === container.children.length
    && plan.chunks[0] === container.firstElementChild;
}

// Build whatever the reader can already see, then hand the rest to the
// observer. Deliberately after the placeholders are in the document, so the
// rects being read are the ones the reader is actually looking at.
export function startNotesLazySpans(container) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return;
  const near = nearNotesLazySpans(container, plan);
  const finished = [];
  near.forEach((index) => { if (buildNotesLazySpan(container, index)) finished.push(index); });
  finished.forEach((index) => finishNotesLazySpan(container, index));
  observeNotesLazySpans(container);
  scheduleNotesLazyDensity(container);
}

// ── Viewport-driven rendering: build a chunk when the reader nears it ──────
//
// Everything above makes a big note render FAST. None of it makes it render
// CHEAPLY: the cost still scales with the note, because a cold open lexes 100%
// of the source (chunked and yielded, but all of it) and builds a DOM node for
// every block in the book before the reader has scrolled a pixel. Painting is
// deferred (content-visibility), diagrams and tables are deferred
// (runNearViewportAndDefer), heights are measured ahead of the reader
// (measureNotesChunkEstimate) — parsing and DOM construction are not. On a
// 20MB note that is the whole complaint: opening it costs twenty megabytes of
// work no matter what the reader intends to read.
//
// So the parse itself becomes viewport-driven. findSafeLexerBoundaries already
// answers, in one cheap O(n) line scan and with no lexing at all, "where can
// this source be cut so that lexing each side independently gives the same
// blocks?". Run it once on open, cut the note into spans at those points, give
// each span an empty chunk wrapper sized by the same height estimate the
// painting path already uses — and then lex and build a span only when it
// approaches the viewport. Opening a note now costs one line scan plus a
// screenful of blocks: proportional to the SCREEN, not to the note.
//
// ── What this is not ──────────────────────────────────────────────────────
//
// It is not virtualization. A span that has been built stays built for as long
// as the note is open — nothing is ever torn back down. That is a deliberate
// v1 boundary: eviction would have to answer to the TOC, backlinks, reading
// anchors, live Selection ranges, highlight DOM ranges and paged mode's column
// layout, every one of which currently relies on "a rendered block stays
// rendered", and several of which have hard-won fixes behind them. Deferring
// the build is the whole of the win for a reading session; capping memory for a
// session that scrolls an entire 20MB book in one sitting is separate work.
//
// It is also not on in paged mode. There a chunk is a CHAPTER, and chapter
// boundaries come from chapterIndexFor(), which full-lexes the document to
// count blocks — so paged mode is O(note) before this could even be consulted.
// Making chapters offset-addressed rather than block-index-addressed is its own
// change; until then paged mode takes exactly the path it takes today.
//
// Correctness is asserted, not argued: tools/viewport-split-check.mjs pins
// every property this rests on — that a span lexed on its own gives the blocks
// a whole-document lex would, that a boundary scan resumed at a safe boundary
// reproduces the tail of the full scan, that the link-reference prelude derived
// from the candidate spans alone equals the whole-document one, and that the
// heading index below agrees with the lexer's own headings.

// Under this the eager path already opens in well under a frame's worth of
// parse per screenful, and the boundary index would be pure overhead.
export const NOTES_LAZY_MIN_CHARS = 200_000;

// How many safe cut points make up one span. Each cut point is a block
// boundary, so this is "about 40 blocks" — deliberately the same unit as
// NOTES_CHUNK_SIZE, so a span IS a chunk and no second granularity is invented.
export const NOTES_LAZY_SPAN_SEGMENTS = 40;

// ...and a ceiling in characters, because 40 blocks of long-form prose is a
// very different amount of lexing from 40 one-line list items. One span must
// stay inside a frame's budget or the promotion that happens as the reader
// approaches it is itself a stutter.
export const NOTES_LAZY_SPAN_MAX_CHARS = 24_000;

// How many spans a note has to be worth deferring at all — and, just as
// importantly, the SAME threshold chunking already uses, counted in spans
// rather than blocks (NOTES_CHUNK_MIN_BLOCKS / NOTES_LAZY_SPAN_SEGMENTS).
//
// That alignment is not tidiness. A lazily built note is always a chunked note,
// because its placeholders ARE chunks; if this were lower, a 200KB note of
// 1,200 blocks would suddenly grow chunk wrappers that the block-count rule
// says it should not have, and "an ordinary note keeps precisely the DOM it has
// always had" would stop being true somewhere nobody had decided it should.
// Two rules that agree by construction cannot drift apart.
export const NOTES_LAZY_MIN_SPANS = NOTES_CHUNK_MIN_BLOCKS / NOTES_LAZY_SPAN_SEGMENTS;

// A source line that could be a link reference definition. Deliberately loose:
// a false positive only costs one extra span lex (the lexer is the authority
// on what is really a definition), a false negative would silently drop a
// definition from the document-wide prelude and turn `[text][id]` into text.
export const NOTES_LAZY_DEFINITION_RE = /^ {0,3}\[[^\]\n]*\]:/gm;

// The prelude is exact — it is taken from real lexes of the spans that could
// contain a definition — but "could contain" is a regex, so a pathological note
// could nominate every span and put the whole document back on the critical
// path. Past this much candidate text the note simply renders eagerly.
export const NOTES_LAZY_PRELUDE_MAX_CHARS = 400_000;

export const NOTES_CHUNK_PENDING_CLASS = "is-pending";

// container -> the span plan its DOM is currently showing.
export const notesLazyPlans = new WeakMap();

export function notesLazyPlan(container) {
  return notesLazyPlans.get(container) || null;
}

// Is this surface holding back part of its note right now? False both for an
// ordinary (eagerly rendered) surface and for a lazily rendered one that has
// since been built all the way through — in both cases every block is in the
// DOM, which is the only thing a caller asking this cares about.
export function notesLazyPending(container) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return false;
  for (let i = 0; i < plan.spans.length; i += 1) if (!plan.built[i]) return true;
  return false;
}

// How much of the note has actually been built, for the checks and for anything
// that wants to report on it.
// How many edits were patched one span at a time, and how many made the note
// re-plan from a fresh boundary scan. Counters for the same reason
// notesIncrementalSplits and notesFullSplits are counters: a local patch that
// silently stopped happening would satisfy every correctness property and
// deliver nothing, and "it still works" cannot see the difference.
// tools/interaction-scale-check.mjs asserts these move.
export let notesLazyLocalPatches = 0;

export let notesLazyReplans = 0;

export function countNotesLazyPatch(local) {
  if (local) notesLazyLocalPatches += 1;
  else notesLazyReplans += 1;
}

// Read through a call, not through the bindings — a checker that snapshots
// module exports into a plain object copies a `let` by VALUE and would measure
// nothing forever. Same trap as notesSplitCounts().
export function notesLazyPatchCounts() {
  return { local: notesLazyLocalPatches, replanned: notesLazyReplans };
}

export function notesLazyStats(container) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return null;
  let built = 0;
  let builtChars = 0;
  for (let i = 0; i < plan.spans.length; i += 1) {
    if (!plan.built[i]) continue;
    built += 1;
    builtChars += plan.spans[i].end - plan.spans[i].start;
  }
  return { spans: plan.spans.length, built, chars: plan.prepared.length, builtChars };
}

// ── The span index ────────────────────────────────────────────────────────
//
// Spans TILE the document: span[0] starts at 0, span[n-1] ends at
// prepared.length, and each span's end is the next one's start. Every internal
// boundary is one findSafeLexerBoundaries produced, which is what makes lexing
// a span on its own equivalent to lexing it in place.
export function planNotesLazySpans(prepared, boundaries) {
  const spans = [];
  let start = 0;
  let segments = 0;
  for (const at of boundaries) {
    segments += 1;
    if (segments < NOTES_LAZY_SPAN_SEGMENTS && at - start < NOTES_LAZY_SPAN_MAX_CHARS) continue;
    spans.push({ start, end: at });
    start = at;
    segments = 0;
  }
  // The tail, however short. Merging it into the span before would be tidier to
  // look at and would cost that span its size bound, which is the one thing a
  // span is not allowed to lose.
  spans.push({ start, end: prepared.length });
  return spans;
}

// The span holding a character offset in `prepared`. Binary search; spans tile,
// so there is always exactly one answer.
export function notesLazySpanAt(plan, offset) {
  const spans = plan.spans;
  let lo = 0;
  let hi = spans.length - 1;
  const at = Math.max(0, Math.min(plan.prepared.length, Number(offset) || 0));
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (spans[mid].start <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Which spans hold a line that could be a link reference definition — the only
// ones that have to be lexed before the document-wide prelude is known.
export function notesLazyDefinitionSpans(prepared, spans) {
  const flagged = new Set();
  const re = new RegExp(NOTES_LAZY_DEFINITION_RE.source, "gm");
  let match;
  let cursor = 0;
  while ((match = re.exec(prepared)) !== null) {
    // The matches come out in document order, so the span search only ever
    // walks forward — a note with thousands of definitions still costs one pass.
    while (cursor < spans.length - 1 && spans[cursor].end <= match.index) cursor += 1;
    flagged.add(cursor);
    if (re.lastIndex === match.index) re.lastIndex += 1;
  }
  return flagged;
}

// One lex of one span, filtered to blocks. Returns null if the lexer threw,
// which is the caller's signal to give up on the lazy path rather than to
// render a wrong or empty note.
export function lexNotesLazySpan(prepared, span) {
  let tokens;
  try {
    tokens = marked.lexer(prepared.slice(span.start, span.end));
  } catch (error) {
    return null;
  }
  const blocks = [];
  for (const token of tokens) {
    if (!isBlockToken(token)) continue;
    blocks.push(token.raw);
  }
  return { blocks, links: tokens.links || {} };
}

// The document-wide link-reference prelude, without lexing the document.
//
// A definition is not local to its block — any block anywhere can point at one —
// so the prelude every block is parsed behind has to be known before the FIRST
// span is built. Reading it off the source with a regex would be wrong (marked
// absorbs a definition that immediately follows a paragraph into that
// paragraph and never registers it — see sameLinkDefinitions), so the spans
// that could hold one are really lexed, in document order, and merged
// first-occurrence-wins exactly as splitPreparedBlocksChunked does. Everything
// else in the document provably registers nothing, because a definition line is
// the only thing that can.
//
// Returns null when the candidates add up to more text than the whole point of
// this allows us to spend.
export function notesLazyPrelude(prepared, spans, candidates, links) {
  const combined = Object.create(null);
  let chars = 0;
  for (const index of Array.from(candidates).sort((a, b) => a - b)) {
    const span = spans[index];
    chars += span.end - span.start;
    if (chars > NOTES_LAZY_PRELUDE_MAX_CHARS) return null;
    const lexed = lexNotesLazySpan(prepared, span);
    if (!lexed) return null;
    links[index] = lexed.links;
    for (const [label, link] of Object.entries(lexed.links)) {
      if (!(label in combined)) combined[label] = link;
    }
  }
  return definitionPrelude(combined);
}

// ── Building one span ─────────────────────────────────────────────────────

// Where each block of a built span begins, relative to the span's own start.
//
// Memoized per span and derived with blockStartOffsets — the same indexOf walk
// the incremental splitter uses — so it costs one pass over ~40 blocks, once.
// Everything that maps between a rendered block and a position in the source
// goes through this: a proportion of the span would put the answer up to forty
// blocks out, which on a resume is the difference between the paragraph the
// reader left and the one before the section heading above it.
export function notesLazySpanStarts(plan, index) {
  if (plan.starts[index]) return plan.starts[index];
  const blocks = plan.blocks[index];
  if (!blocks) return null;
  const span = plan.spans[index];
  const starts = blockStartOffsets(plan.prepared.slice(span.start, span.end), blocks);
  plan.starts[index] = starts;
  return starts;
}

// The block index inside `index`'s span that `node` belongs to, or -1. `node`
// may be anything under the chunk (a <li>, a <td>) — what is looked for is the
// top-level block that owns it.
export function notesLazyBlockIndexFor(plan, index, node) {
  const chunk = plan.chunks[index];
  const groups = plan.groups[index];
  if (!chunk || !groups) return -1;
  let top = node;
  while (top && top.parentNode && top.parentNode !== chunk) top = top.parentNode;
  if (!top || top.parentNode !== chunk) return -1;
  for (let n = 0; n < groups.length; n += 1) {
    if (groups[n] && groups[n].includes(top)) return n;
  }
  // ── The node the span remembers is not always the node in the DOM ────────
  //
  // A block gets WRAPPED after it is built — every image and diagram picks up a
  // .diagram-shell, every table a .markdown-table-wrap, a numbered equation a
  // .has-eqn-num-block — and the wrapper, not the original node, is what the
  // chunk holds from then on. liveBlockNodes has the same problem on the eager
  // path and solves it by resolving to the top-level ancestor; here the groups
  // still name the node that USED to be top level, so the identity test above
  // misses.
  //
  // Falling through to -1 was not a small error. The caller then has nothing
  // better than the span's own start, which on a 24,000-character span puts its
  // answer up to a whole span out — and its answer is the hint a snippet search
  // is centred on, so a search that should have found the paragraph under the
  // reader instead finds a different copy of the same words twenty thousand
  // characters away. That is a reading position quietly saved in the wrong
  // chapter. The child index is exact whenever a block owns one element (which
  // is nearly always) and never worse than a block or two otherwise.
  const at = Array.prototype.indexOf.call(chunk.children, top);
  if (at >= 0 && groups.length) return Math.min(at, groups.length - 1);
  return -1;
}

// The chunk standing in for a character offset in the prepared text, built or
// not. This is what lets anything geometric answer for a part of the note that
// has not been rendered — the placeholder is a real box in the document with
// the note's own measured height estimate on it.
// Roughly where a character offset sits ON THE GLASS, without building
// anything: the chunk standing in for it, interpolated by how far into that
// span the offset is.
//
// The interpolation is not a nicety. Answering with the chunk's TOP for every
// offset inside it makes forty blocks share one position, and anything doing a
// binary search over those positions (the contents' active row) then picks the
// last of them rather than the right one — the row lit while reading chapter 31
// was chapter 32. Interpolating keeps the answer monotonic in document order,
// which is what the search needs, and puts it inside a block or two.
export function notesLazyTopAtOffset(container, offset) {
  const plan = container ? notesLazyPlans.get(container) : null;
  if (!plan) return null;
  const index = notesLazySpanAt(plan, offset);
  const chunk = plan.chunks[index];
  if (!chunk || !chunk.isConnected) return null;
  const box = chunk.getBoundingClientRect();
  const span = plan.spans[index];
  const width = span.end - span.start;
  const through = width > 0 ? Math.max(0, Math.min(1, (offset - span.start) / width)) : 0;
  return box.top + through * box.height;
}

// A chunk that has been built and holds a diagram or a table has to opt out of
// containment as a whole, the way blockWantsOwnChunk's solo chunks do on the
// eager path: those elements run their own IntersectionObservers and need real
// geometry. On the eager path such a block gets a chunk to ITSELF; here it
// takes its whole span with it, which costs some layout on the handful of spans
// that contain one and nothing at all on a book of prose.
export function markNotesLazyChunkContainment(chunk) {
  const uncontained = Boolean(chunk.querySelector(".diagram-shell, .markdown-table-wrap, .mermaid, .nomnoml-diagram, table"));
  chunk.classList.toggle("is-uncontained", uncontained);
}

// Build one span: lex it, parse its blocks, put them in its chunk. Synchronous
// on purpose — every caller either has the reader waiting on it (a jump landing
// here) or is running off an intersection callback with a 1200px runway, and a
// span is size-bounded precisely so this fits in a frame.
//
// Returns the freshly built nodes, or null when there was nothing to do.
export function buildNotesLazySpan(container, index) {
  const plan = notesLazyPlans.get(container);
  if (!plan || index < 0 || index >= plan.spans.length) return null;
  if (plan.built[index]) return null;
  const chunk = plan.chunks[index];
  if (!chunk || !chunk.isConnected) return null;

  const lexed = lexNotesLazySpan(plan.prepared, plan.spans[index]);
  if (!lexed) {
    // The lexer threw on this span. Marking it built with nothing in it would
    // silently delete a chunk of the book; marking it built with its SOURCE in
    // it keeps the text readable, which is the same trade safeHtmlFromPrepared
    // makes when the libraries are missing.
    plan.built[index] = 1;
    plan.blocks[index] = [];
    plan.groups[index] = [];
    plan.starts[index] = null;
    chunk.classList.remove(NOTES_CHUNK_PENDING_CLASS);
    return null;
  }

  const parts = renderPreparedBlocks(lexed.blocks, plan.prelude);
  const groups = lexed.blocks.map((_, n) => nodesFromHtml(parts[n] ?? ""));
  const flat = [];
  groups.forEach((nodes) => nodes.forEach((node) => flat.push(node)));

  plan.blocks[index] = lexed.blocks;
  plan.groups[index] = groups;
  plan.starts[index] = null;
  plan.links[index] = lexed.links;
  plan.built[index] = 1;
  chunk.replaceChildren(...flat);
  chunk.classList.remove(NOTES_CHUNK_PENDING_CLASS);
  // A span that has just become real must stop claiming a placeholder height:
  // its own content is what keeps the scrollbar still from here on, and
  // notesChunkEstimateObserver is already watching it to pin the measurement.
  chunk.style.removeProperty("--span-estimate");
  refreshNotesLazyCacheBlocks(container, plan);
  bindNotesHeadingElements(container, plan.spans[index].start, plan.spans[index].end, chunk);
  return flat;
}

// The block cache entry for a lazily-rendered note lists the blocks that are
// really in the DOM — no more. patchRenderedBlocks pools by block SOURCE rather
// than by index, so this is exactly what an eager render falling back onto a
// half-built note needs in order to reuse what is already there; and
// notes/raw-offset.js reads the plan instead, because a proportion taken over
// "whatever happens to be built" would move as the reader scrolled.
export function refreshNotesLazyCacheBlocks(container, plan) {
  const cached = renderedBlockCache.get(container);
  if (!cached || cached.lazy !== plan) return;
  const blocks = [];
  for (let i = 0; i < plan.spans.length; i += 1) {
    const raws = plan.blocks[i];
    const groups = plan.groups[i];
    if (!raws || !groups) continue;
    for (let n = 0; n < raws.length; n += 1) blocks.push({ key: raws[n], nodes: groups[n] });
  }
  cached.blocks = blocks;
  // blockKeyLengthTotal memoizes onto the entry, and the entry's block list has
  // just changed underneath it.
  cached.totalKeyLength = null;
}

// Build the span holding a character offset in the PREPARED text, if it is not
// built already. THE entry point for "something needs this part of the note to
// exist right now" — a reading-position restore, a heading jump, a highlight
// the Highlights panel is pointing at.
export function ensureNotesLazyOffsetBuilt(container, offset) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return false;
  const index = notesLazySpanAt(plan, offset);
  if (plan.built[index]) return false;
  // Just this span. Building its neighbours as well was tried, on the theory
  // that a landing settles better when the geometry above and below it is
  // already final — measured, it moved which block sits on the reading line and
  // bought nothing the intersection observer does not do a frame later anyway,
  // so the jump builds exactly what it needs and no more.
  buildNotesLazySpan(container, index);
  finishNotesLazySpan(container, index);
  return true;
}

// Same, addressed by a fraction of the document rather than by an offset —
// which is how every caller that only has a RAW-markdown offset can ask,
// preprocessSpecialBlocks having moved every absolute position.
export function ensureNotesLazyFractionBuilt(container, fraction) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return false;
  const at = Math.max(0, Math.min(1, Number(fraction) || 0)) * plan.prepared.length;
  return ensureNotesLazyOffsetBuilt(container, at);
}

// Enhancement, image hydration and the containment mark for a span that was
// just built. Split from buildNotesLazySpan because the build has to be
// synchronous (a jump is waiting on it) and this half is asynchronous.
export function finishNotesLazySpan(container, index) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return;
  const chunk = plan.chunks[index];
  const groups = plan.groups[index];
  if (!chunk || !groups) return;
  const flat = [];
  groups.forEach((nodes) => nodes.forEach((node) => flat.push(node)));
  if (!flat.length) return;
  Promise.resolve()
    .then(() => enhanceRenderedMarkdown(container, flat))
    .then(() => hydrateLocalImages(flat))
    .then(() => { markNotesLazyChunkContainment(chunk); })
    .catch((error) => console.warn("Deferred note span failed", error));
}

// ── Promotion as the reader approaches ────────────────────────────────────
//
// The same shape as notesChunkEstimateObserver above and deferredWorkObserver
// in render/deferred-work.js: one observer per scroll root, memoized, with
// DEFERRED_WORK_MARGIN of runway. One-shot per chunk — a built span is
// unobserved, so a note that has been read all the way through stops costing
// anything at all.
export const notesLazyBuildObservers = new Map();

export function notesLazyBuildObserver(root) {
  const existing = notesLazyBuildObservers.get(root);
  if (existing) return existing;
  const observer = new IntersectionObserver(
    (entries) => {
      const plan = notesLazyPlans.get(root);
      if (!plan) return;
      // Built synchronously, straight off the entry, for the same reason
      // measureNotesChunkEstimate is: routing this through the shared idle
      // queue stacks up to 250ms of drain latency on top of the runway, and a
      // fling covers 1200px well inside that. The span size bound is what makes
      // that affordable — see NOTES_LAZY_SPAN_MAX_CHARS.
      const finished = [];
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        const index = plan.chunks.indexOf(entry.target);
        if (index === -1) return;
        if (buildNotesLazySpan(root, index)) finished.push(index);
      });
      finished.forEach((index) => finishNotesLazySpan(root, index));
      if (finished.length) {
        scheduleNotesChunkEstimates(root);
        // Both estimates get another chance every time a span lands. The
        // note-wide block estimate needs NOTES_ESTIMATE_MIN_BLOCKS to be in the
        // DOM before it can measure anything, and on a note built as it is read
        // the first paint may not have that many — scheduling it only from the
        // render tail would leave it never measured at all, and every
        // placeholder in the book stuck on the stylesheet's flat fallback.
        scheduleNotesBlockEstimate(root);
        scheduleNotesLazyDensity(root);
      }
    },
    { root, rootMargin: `${DEFERRED_WORK_MARGIN}px 0px` }
  );
  notesLazyBuildObservers.set(root, observer);
  return observer;
}

export function releaseNotesLazyBuildObserver(root) {
  const observer = notesLazyBuildObservers.get(root);
  if (observer) {
    observer.disconnect();
    notesLazyBuildObservers.delete(root);
  }
}

// Stop describing this surface as viewport-built — and say so in the BLOCK
// CACHE as well as in the plan map.
//
// Both, or neither. The cache entry carries a reference to the plan, and
// notes/raw-offset.js reads it to map between a rendered block and a position in
// the source: it finds the block's chunk, looks that chunk up in the plan's
// list, and takes the span's offset. Drop the plan from the map alone and that
// entry still points at it — at a span list describing a grouping of chunks the
// DOM no longer has, because the note has since been re-homed into 40-block
// chunks by rechunkRenderedBlocks. Every offset it answers is then plausible and
// wrong, which is exactly how a reading position comes back forty per cent of a
// book away from where it was taken.
export function forgetNotesLazyPlan(container) {
  if (!notesLazyPlans.has(container)) return;
  notesLazyPlans.delete(container);
  releaseNotesLazyBuildObserver(container);
  const cached = renderedBlockCache.get(container);
  if (!cached || !cached.lazy) return;
  cached.lazy = null;
  // cached.blocks is already the whole note (the plan was materialized before
  // it was dropped), so the ordinary key-length mapping takes over from here —
  // it just has to be told to re-add up what it memoized.
  cached.totalKeyLength = null;
}

export function observeNotesLazySpans(container) {
  const plan = notesLazyPlans.get(container);
  if (!plan || typeof IntersectionObserver !== "function") return;
  const observer = notesLazyBuildObserver(container);
  plan.chunks.forEach((chunk, index) => {
    if (!plan.built[index]) observer.observe(chunk);
  });
}

// Build everything that is still pending, yielding between spans.
//
// For anything that needs the WHOLE note to be real: an export, a print, a
// find-across-the-note. Additive rather than a second code path — it is the
// same per-span build, run until there is nothing left.
export async function materializeNotesLazySpans(container, sequenceOk = () => true) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return true;
  let at = 0;
  while (at < plan.spans.length) {
    const started = performance.now();
    const finished = [];
    while (at < plan.spans.length && performance.now() - started < RENDER_BATCH_BUDGET_MS) {
      if (!plan.built[at] && buildNotesLazySpan(container, at)) finished.push(at);
      at += 1;
    }
    finished.forEach((index) => finishNotesLazySpan(container, index));
    if (at < plan.spans.length) {
      await yieldToEventLoop();
      if (!sequenceOk()) return false;
      if (notesLazyPlans.get(container) !== plan) return false;
    }
  }
  scheduleNotesChunkEstimates(container);
  return true;
}

// Synchronous variant, for callers that cannot await (an export path already
// inside a synchronous DOM capture). Costs the whole remaining note in one
// task, which is exactly what it is asking for.
export function materializeNotesLazySpansSync(container) {
  const plan = notesLazyPlans.get(container);
  if (!plan) return;
  for (let i = 0; i < plan.spans.length; i += 1) {
    if (!plan.built[i]) buildNotesLazySpan(container, i);
  }
}

// ── Putting the placeholders on screen ────────────────────────────────────

export function buildNotesLazyChunks(container, plan) {
  const fragment = document.createDocumentFragment();
  plan.chunks = plan.spans.map((span) => {
    const chunk = document.createElement("div");
    chunk.className = `${NOTES_CHUNK_CLASS} ${NOTES_CHUNK_PENDING_CLASS}`;
    // How much SOURCE this placeholder stands for, so the density measured
    // below can turn it into a height. Written now rather than later because it
    // never changes for the life of the span and this is the one pass that
    // touches every chunk.
    chunk.style.setProperty("--span-chars", String(span.end - span.start));
    fragment.appendChild(chunk);
    return chunk;
  });
  container.replaceChildren(fragment);
}

// ── Sizing a placeholder by how much SOURCE it stands for ─────────────────
//
// --notes-chunk-estimate is the note's average block height times
// NOTES_CHUNK_SIZE, and it is the right answer for a chunk of exactly forty
// average blocks. A SPAN is not that: it is forty safe cut points or 24,000
// characters, whichever comes first, so a span of dense prose and a span of
// one-line dialogue hold wildly different amounts of text and the block-count
// estimate is wrong for both — in opposite directions.
//
// What every span does share is a rate: how many pixels a character of this
// note's source turns into. That is measurable the moment two spans have been
// built, and it is measured off chunks that are on screen and therefore already
// laid out, so it costs no layout of its own. A pending chunk is then sized by
// its own character count.
//
// Once per note, like every other estimate here (measureNotesBlockEstimate says
// why: a revision resizes everything not yet visited at once, which is a single
// enormous jump rather than the settling it was meant to cure).
export function measureNotesLazyDensity(container) {
  const plan = notesLazyPlans.get(container);
  if (!plan || plan.density) return;
  // ── Only chunks that are ON SCREEN ───────────────────────────────────────
  //
  // The trap measureNotesBlockEstimate documents, one level up: a box whose
  // layout `content-visibility` skipped answers offsetHeight with its
  // contain-intrinsic-size — the ESTIMATE — not with its content's height. A
  // built chunk sitting below the fold therefore reports the flat 4,800px
  // fallback, and a density averaged over those is a measurement of the guess
  // it was supposed to replace. (Measured with that mistake in place: the same
  // 3.1MB note claimed 2.25 million pixels on one run and 1.23 million on the
  // next, purely on how many of its built chunks happened to be off screen when
  // the sample was taken. A document whose height moves like that moves the
  // reader's position with it.)
  //
  // A chunk intersecting the viewport is by definition relevant to the user and
  // therefore really laid out, so the sample is taken from those alone — and one
  // is enough, because this is a rate over CHARACTERS, which barely varies
  // across a book, rather than a per-block height, which varies enormously.
  const bounds = container.getBoundingClientRect();
  let height = 0;
  let chars = 0;
  for (let i = 0; i < plan.spans.length; i += 1) {
    if (!plan.built[i]) continue;
    const chunk = plan.chunks[i];
    if (!chunk?.isConnected) continue;
    const box = chunk.getBoundingClientRect();
    if (box.bottom <= bounds.top || box.top >= bounds.bottom || box.height <= 0) continue;
    height += box.height;
    chars += plan.spans[i].end - plan.spans[i].start;
  }
  if (chars <= 0 || height <= 0) return;
  plan.density = height / chars;
  plan.chunks.forEach((chunk, i) => {
    if (plan.built[i]) return;
    const span = plan.spans[i];
    chunk.style.setProperty("--span-estimate", `${Math.round(plan.density * (span.end - span.start))}px`);
  });
}

export let notesLazyDensityFrame = 0;

export function scheduleNotesLazyDensity(container) {
  if (!notesLazyPlans.has(container) || notesLazyDensityFrame) return;
  // Deferred a frame for the same reason scheduleNotesBlockEstimate is: reading
  // offsetHeight forces layout, and the tail of a render is the one moment the
  // browser most wants back so it can paint.
  notesLazyDensityFrame = requestAnimationFrame(() => {
    notesLazyDensityFrame = 0;
    measureNotesLazyDensity(el.notesView);
  });
}

// The spans the reader can already see, plus the runway. Read as rects in one
// pass before anything is built, the same discipline
// partitionByViewportProximity keeps: interleaving reads with builds is what
// turns one layout into one layout per span.
export function nearNotesLazySpans(container, plan) {
  const bounds = container.getBoundingClientRect();
  const top = bounds.top - DEFERRED_WORK_MARGIN;
  const bottom = bounds.bottom + DEFERRED_WORK_MARGIN;
  const near = [];
  plan.chunks.forEach((chunk, index) => {
    if (plan.built[index]) return;
    const rect = chunk.getBoundingClientRect();
    if (rect.bottom >= top && rect.top <= bottom) near.push(index);
  });
  // A note whose placeholders have no height yet (the estimate has never been
  // measured and the stylesheet fallback did not apply) would answer with
  // nothing, and a note that renders nothing is worse than one that renders too
  // much. The first span is always built.
  if (!near.length && !plan.built[0]) near.push(0);
  return near;
}

// ── An edit, without giving up the laziness ───────────────────────────────
//
// The reader highlights a paragraph in chapter 30 of a book that is 4% built.
// Re-planning from scratch would be correct (the boundary scan is derived from
// the new document, so no certificate is needed at all) but it costs a line
// scan of the whole note on every edit — the exact O(document) pass
// incrementalSplitPreparedBlocks exists to avoid. So the local case is taken
// locally, and re-planning is the fallback rather than the rule.
//
// The claim: when the change lies strictly inside one span, and past that
// span's first line, then that span's START is still a safe boundary of the new
// document (everything before it is byte-identical, and the boundary rule reads
// only backwards and the line at the cut), and its END is still one exactly
// when a rescan says so. Rescanning is not an approximation of the rule — it IS
// the rule, run again: findSafeLexerBoundaries resumed AT a safe boundary
// begins in the same state the full scan was in there (outside any fence, no
// blank run open, previous line not safe), so the boundaries it reports for the
// window are the document's own. tools/viewport-split-check.mjs asserts that
// resumption property directly.
//
// Everything after the confirmed end boundary is byte-identical text lexed from
// a canonical state, so no span past the edited one can have changed — which is
// why only the one span is rebuilt and every other chunk, built or pending, is
// left exactly as it is.
export function patchNotesLazyPlanLocally(container, plan, prepared) {
  const range = preparedEditRange(plan.prepared, prepared);
  if (!range) return "unchanged";
  const index = notesLazySpanAt(plan, range.head);
  const span = plan.spans[index];
  const first = index === 0;
  const last = index === plan.spans.length - 1;
  // ── The left cut ────────────────────────────────────────────────────────
  //
  // Unchanged when everything before it is unchanged AND the line it lands on
  // is — that line's shape (indented? a list marker? a quote?) is half of why
  // the cut was safe. The first span has no left cut at all, so there is
  // nothing there to preserve and an edit at the very top of a note is
  // ordinary rather than exotic.
  if (!first) {
    if (!(span.start < range.head)) return null;
    const firstBreak = plan.prepared.indexOf("\n", span.start);
    if (firstBreak === -1 || range.head <= firstBreak) return null;
  }
  // ── The right cut ───────────────────────────────────────────────────────
  //
  // The change has to stop short of it, or it is not one span's edit. The last
  // span's right edge is the end of the document, which is not a cut and which
  // an append is allowed to move.
  if (!last && !(range.tailBefore < span.end)) return null;

  const delta = prepared.length - plan.prepared.length;
  const newEnd = span.end + delta;
  if (newEnd <= span.start) return null;
  if (newEnd - span.start > NOTES_LAZY_SPAN_MAX_CHARS * 4) return null;

  if (!last) {
    // Two spans of window, so the rescan has a line of context past the cut it
    // is being asked about rather than deciding on a truncated last line.
    const stop = Math.min(prepared.length, (plan.spans[index + 2]?.end ?? plan.prepared.length) + delta);
    const rescan = findSafeLexerBoundaries(prepared.slice(span.start, stop));
    if (!rescan.includes(newEnd - span.start)) return null;
  }

  const lexed = lexNotesLazySpan(prepared, { start: span.start, end: newEnd });
  if (!lexed) return null;
  // The prelude is document-wide, so a definition appearing, vanishing or
  // changing inside this span changes how every block in the book renders. The
  // comparison is between two real lexes of the span, which is exact where a
  // scan of the source is not — same reasoning as sameLinkDefinitions' own.
  if (!sameLinkDefinitions(plan.links[index] || {}, lexed.links)) return null;

  const spans = plan.spans.slice();
  spans[index] = { start: span.start, end: newEnd };
  for (let i = index + 1; i < spans.length; i += 1) {
    spans[i] = { start: spans[i].start + delta, end: spans[i].end + delta };
  }
  plan.spans = spans;
  plan.prepared = prepared;
  plan.links[index] = lexed.links;
  plan.starts[index] = null;
  if (plan.built[index]) rebuildNotesLazySpan(container, plan, index, lexed.blocks);
  else plan.blocks[index] = null;
  return "patched";
}

// Re-home a built span's chunk onto a new block list, reusing the DOM of every
// block whose source did not change. The same pool-and-walk patchRenderedBlocks
// does, scoped to one chunk — which is all an edit can reach.
export function rebuildNotesLazySpan(container, plan, index, blocks) {
  const chunk = plan.chunks[index];
  const pool = new Map();
  (plan.blocks[index] || []).forEach((key, n) => {
    const nodes = (plan.groups[index] || [])[n];
    if (!nodes || !nodes.length) return;
    const live = nodes.filter((node) => node.parentNode === chunk);
    if (!live.length) return;
    const bucket = pool.get(key);
    if (bucket) bucket.push(live);
    else pool.set(key, [live]);
  });

  const groups = new Array(blocks.length);
  const missing = [];
  blocks.forEach((key, n) => {
    const bucket = pool.get(key);
    const reused = bucket && bucket.length ? bucket.shift() : null;
    if (reused) groups[n] = reused;
    else missing.push(n);
  });
  const fresh = [];
  if (missing.length) {
    const parts = renderPreparedBlocks(missing.map((n) => blocks[n]), plan.prelude);
    missing.forEach((n, part) => {
      const nodes = nodesFromHtml(parts[part] ?? "");
      groups[n] = nodes;
      nodes.forEach((node) => fresh.push(node));
    });
  }

  let cursor = chunk.firstChild;
  groups.forEach((nodes) => {
    nodes.forEach((node) => {
      if (node === cursor) {
        cursor = cursor.nextSibling;
        return;
      }
      chunk.insertBefore(node, cursor);
    });
  });
  while (cursor) {
    const next = cursor.nextSibling;
    chunk.removeChild(cursor);
    cursor = next;
  }

  plan.blocks[index] = blocks;
  plan.groups[index] = groups;
  plan.starts[index] = null;
  refreshNotesLazyCacheBlocks(container, plan);
  bindNotesHeadingElements(container, plan.spans[index].start, plan.spans[index].end, chunk);
  if (fresh.length) {
    Promise.resolve()
      .then(() => enhanceRenderedMarkdown(container, fresh))
      .then(() => hydrateLocalImages(fresh))
      .then(() => { markNotesLazyChunkContainment(chunk); })
      .catch((error) => console.warn("Note span re-render failed", error));
  }
}

// Re-plan from a fresh boundary scan, keeping every chunk whose span text is
// byte-identical to one the previous plan had. No certificate is involved
// because nothing is being carried over about the CUTS — they are derived from
// the new document — only about the CONTENT behind cuts that came out the same.
export function replanNotesLazySpans(container, plan, prepared, spans, candidates, links, prelude) {
  const range = preparedEditRange(plan.prepared, prepared);
  const delta = prepared.length - plan.prepared.length;
  // Where an old span's text survives unchanged, and at what offset. Before the
  // edit the span is where it was; after it, it has slid by delta. A span
  // straddling the edit is in neither set, which is exactly right.
  const survivors = new Map();
  if (range) {
    plan.spans.forEach((span, index) => {
      if (span.end <= range.head) survivors.set(`${span.start}:${span.end}`, index);
      else if (span.start >= range.tailBefore) survivors.set(`${span.start + delta}:${span.end + delta}`, index);
    });
  }

  const chunks = [];
  const blocks = [];
  const groups = [];
  const starts = [];
  const built = new Uint8Array(spans.length);
  const kept = new Set();
  spans.forEach((span, index) => {
    const from = survivors.get(`${span.start}:${span.end}`);
    if (from === undefined || !plan.built[from] || kept.has(from) || !plan.chunks[from]?.isConnected) {
      const chunk = document.createElement("div");
      chunk.className = `${NOTES_CHUNK_CLASS} ${NOTES_CHUNK_PENDING_CLASS}`;
      chunk.style.setProperty("--span-chars", String(span.end - span.start));
      if (plan.density) chunk.style.setProperty("--span-estimate", `${Math.round(plan.density * (span.end - span.start))}px`);
      chunks.push(chunk);
      blocks.push(null);
      groups.push(null);
      starts.push(null);
      return;
    }
    kept.add(from);
    chunks.push(plan.chunks[from]);
    blocks.push(plan.blocks[from]);
    groups.push(plan.groups[from]);
    // The offsets are relative to the span's own start, and a surviving span is
    // one whose TEXT is unchanged — so they survive the slide by delta too.
    starts.push(plan.starts[from]);
    built[index] = 1;
  });

  // One pass over the container: every kept chunk is moved into its new place
  // and every replaced one is dropped, rather than replaceChildren throwing
  // away the layout memory of chunks that did not change (see the note above
  // rechunkRenderedBlocks — that memory is what stops a long note jumping).
  const wanted = new Set(chunks);
  Array.from(container.children).forEach((node) => { if (!wanted.has(node)) node.remove(); });
  chunks.forEach((chunk, index) => {
    if (container.children[index] !== chunk) container.insertBefore(chunk, container.children[index] || null);
  });

  plan.prepared = prepared;
  plan.prelude = prelude;
  plan.spans = spans;
  plan.chunks = chunks;
  plan.blocks = blocks;
  plan.groups = groups;
  plan.starts = starts;
  plan.built = built;
  plan.links = links;
  plan.candidates = candidates;
  return plan;
}

// Rebuilding a view used to put every {{cloze}} back in its hidden state, and
// the flip-all button is reset to match after each render. Reused blocks keep
// whatever the reader flipped open, so hide them explicitly to keep that
// contract — otherwise the button and the text disagree.
// promoteNotesHeadings (render/enhance.js) splits every line of the note and
// allocates a parallel array of heading levels. Cheap per character and O(the
// whole document) all the same — and it runs on every render of the notes view,
// including the ones that go on to hit the block cache and do nothing else at
// all: the raw<->rendered toggle, a paged-layout re-render, a re-entry into
// notes view. One entry is all it needs, because the question is always "this
// same note again"; an edit misses it and pays for the walk exactly as before.
export let promotedNotesSource = null;

export let promotedNotesResult = null;

export function promotedNotesHeadings(markdown) {
  if (markdown === promotedNotesSource) return promotedNotesResult;
  promotedNotesResult = promoteNotesHeadings(markdown);
  promotedNotesSource = markdown;
  return promotedNotesResult;
}

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
  if (container === el.notesView) displayMarkdown = promotedNotesHeadings(displayMarkdown);

  const cacheable = isCachedRenderSurface(container);
  const cached = cacheable ? renderedBlockCache.get(container) : null;
  // The whole point: same content, same theme, and the DOM on screen is already
  // the answer. This is the raw → rendered toggle when nothing was edited.
  if (cached && cached.generation === renderGeneration && cached.source === displayMarkdown) {
    resetRenderedClozes(container);
    // Same content, same DOM — but on a note that is built as it is read, "the
    // DOM on screen is already the answer" is only true for the part of it that
    // has been built. Re-entering the view (the raw<->rendered toggle, coming
    // back from Cards) can leave the reader looking at a span that went pending
    // while the surface was hidden and no intersection was reported. Cheap: a
    // rect read per pending chunk, and nothing at all once the note is whole.
    if (notesLazyPending(container)) startNotesLazySpans(container);
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

  // ── What to patch, when the source has MOVED rather than matched ──────────
  //
  // An edit to the note the reader is looking at — every highlight, cloze, erase
  // and formatting action — and it is the case the whole-document re-lex was
  // costing the most. See incrementalSplitPreparedBlocks.
  //
  // The base is the BLOCK CACHE's own entry, not notesParseHistory, and that
  // distinction is load-bearing rather than incidental. notesParseHistory is
  // keyed by deck identity, and a deck's identity is not stable across its first
  // save: currentNotesParseKey() answers [null,null,null] for a note that has
  // never been written and [null,"ld_…",null] the moment the autosave assigns a
  // local id. So the entry stored while reading was filed under a name the first
  // edit could no longer look up, and every edit fell through to a full re-lex —
  // silently, because falling through is also the correct answer for a hundred
  // other reasons. (tools/interaction-scale-check.mjs asserts the counters for
  // exactly this reason; it caught this.)
  //
  // renderedBlockCache has no such question to answer. It is keyed by the
  // container and it means "what is on this surface right now", which is
  // precisely what an edit is an edit TO. A note SWITCH lands here too and is
  // harmless: two different notes diff as a document-wide change, which the
  // window bound rejects before any lexing happens.
  //
  // The generation test is stricter than it needs to be — the split is a pure
  // function of `prepared` and owes nothing to the mermaid theme — but it keeps
  // this in step with reuseParse above, and the cost is one full parse after a
  // theme flip.
  const editBase = !reuseParse && cached
    && cached.generation === renderGeneration
    && cached.prepared
    && cached.split
    && displayMarkdown.length >= NOTES_INCREMENTAL_SPLIT_MIN_CHARS
    ? cached
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
  // Each block's offset in `prepared`, when we already know it. Carried through
  // rather than recomputed, so a raw<->rendered toggle between two edits does not
  // throw the memo away and make the next edit re-walk the document.
  let starts = null;
  if (reuseParse) {
    prepared = reuseParse.prepared;
    split = reuseParse.split;
    starts = reuseParse.starts || null;
  } else {
    if (hugeCold) {
      await yieldToEventLoop();
      if (!sequenceOk()) return;
    }
    prepared = preprocessSpecialBlocks(displayMarkdown);
    if (hugeCold) {
      await yieldToEventLoop();
      if (!sequenceOk()) return;
    }
  }

  // ── Build only what the viewport needs ──────────────────────────────────
  //
  // Ahead of every splitter below, because the whole point of it is that no
  // splitter runs: a note this size is cut into spans by one line scan and only
  // the spans near the reader are lexed at all. Declining (paged mode, a
  // document with no safe cut in it, a prelude too expensive to derive without
  // the full lex) returns null and everything below is byte for byte the path
  // this has always taken.
  //
  // `!split` guards a parse-history hit: if the whole document has already been
  // lexed for this exact source, spending it is free and reusing it is better
  // than throwing it away to be lazy about work that is already done.
  const lazily = !split && canRenderNotesLazily(container, prepared)
    ? await renderNotesLazily(container, prepared, sequenceOk)
    : null;
  if (lazily === "superseded") return;

  if (!lazily && !split) {
    // Patch the previous block array where the edit was local enough to prove it
    // — one lex of a few KB instead of the whole note, and no yields, so an edit
    // repaints in the same frame rather than eleven frames later. Null means
    // "could not prove it", and everything below is then byte for byte the path
    // this has always taken.
    const patched = editBase ? incrementalSplitPreparedBlocks(editBase, prepared) : null;
    if (editBase) countNotesSplit(Boolean(patched));
    if (patched) {
      split = patched.split;
      starts = patched.starts;
    } else if (hugeCold) {
      split = await splitPreparedBlocksChunked(prepared, sequenceOk);
      if (!sequenceOk()) return;
    } else {
      split = cacheable ? splitPreparedBlocks(prepared) : null;
    }
  }

  if (lazily) {
    const plan = notesLazyPlan(container);
    // Committed BEFORE the spans are built, because buildNotesLazySpan writes
    // this entry's block list as it goes (refreshNotesLazyCacheBlocks) — the
    // list is "what is really in the DOM", which is exactly what an eager
    // re-render falling back onto a half-built note can reuse.
    renderedBlockCache.set(container, {
      generation: renderGeneration,
      source: displayMarkdown,
      prelude: plan.prelude,
      blocks: [],
      prepared,
      split: null,
      starts: null,
      lazy: plan
    });
    startNotesLazySpans(container);
    resetRenderedClozes(container);
    if (renderSequence.get(container) !== sequence) return;
    scheduleSurfaceFinalize(container);
    return;
  }
  if (notesKey && split) {
    rememberNotesParseHistory(notesKey, { generation: renderGeneration, source: displayMarkdown, prepared, split, starts });
  }
  // Whatever happens below rebuilds the container from a whole-document block
  // list, so a plan describing spans is no longer describing this DOM.
  forgetNotesLazyPlan(container);

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
      blocks: patched.blocks,
      // The parse this DOM was built from, so the next edit to the same surface
      // can patch it rather than re-lex the note — see editBase above. `starts`
      // may be null; incrementalSplitPreparedBlocks derives and memoizes it on
      // first use, which is what keeps the O(n) walk to once per full parse.
      prepared,
      split,
      starts
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
