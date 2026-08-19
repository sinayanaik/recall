// The link between a card and the place in the notes it came from.
//
// An anchor is a text snippet plus a hint, not an offset — the note gets edited
// and offsets rot, so the anchor is re-found by matching and only falls back to
// the hint when that fails.

import { activeDeckMatchesMasterOrder } from "../cards/all-cards-edit.js?v=__BUILD__";
import { updateMeta } from "../cards/card-status.js?v=__BUILD__";
import { syncResults } from "../cards/study.js?v=__BUILD__";
import { supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { loadWebDeck } from "../cloud/web-decks.js?v=__BUILD__";
import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { locateSelectionInSource, renderedSelectionStrings } from "../format/locate-selection.js?v=__BUILD__";
import { loadDeckFromLibrary } from "../library/local-library.js?v=__BUILD__";
import { scrollTextareaToOffset } from "./caret.js?v=__BUILD__";
import { NOTES_PROGRAMMATIC_SCROLL_MS, markProgrammaticNotesScroll, markProgrammaticNotesSelection } from "./notes-view.js?v=__BUILD__";
import { estimateNotesPageForFraction, isNotesPaged, notesPageCount, notesPageForElement, revealInPagedNotes, revealRangeInPagedNotes } from "./paged-view.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR, approximateRawOffsetForBlock, notesBlockForRawOffset } from "./raw-offset.js?v=__BUILD__";
import { notesReadingLineOffset } from "./scroll-anchor.js?v=__BUILD__";
import { SELECTION_TARGETS, isTargetEditing, notesSelectionRange } from "./selection.js?v=__BUILD__";
import { notesTopLevelBlocks, renderMarkdown, withChunkRendered } from "../render/block-cache.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { setStatus, showToast } from "../ui/feedback.js?v=__BUILD__";
import { lockPageScroll, unlockPageScroll } from "../ui/overlays.js?v=__BUILD__";
import { setViewMode } from "../ui/view-mode.js?v=__BUILD__";

export function addCardFromNotes(question, answer, noteAnchor = null) {
  const card = {
    // Random suffix: bare Date.now() collides when cards are created from
    // several selections in quick succession.
    id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    answer
  };
  // Remember where in these notes the answer came from, so the card can offer
  // a "Go to notes" jump back to that exact spot (see resolveCardNoteAnchor /
  // jumpToNoteForCurrentCard). Only cards distilled from a notes selection get
  // this; a selection made in a card face passes null.
  if (noteAnchor && (noteAnchor.text || noteAnchor.source)) card.noteAnchor = noteAnchor;
  const refreshActive = activeDeckMatchesMasterOrder();
  state.masterCards.push(card);
  if (refreshActive) state.cards.push(card);
  syncResults();
  updateMeta();
  scheduleDeckAutosave();
  showToast(`Card added · ${state.masterCards.length} total`);
  setStatus(state.deckId ? "Card added from notes locally. Sync to update the web deck." : "Card added from notes.");
}

export function createCardFromNotesSelection(markdown, noteAnchor = null) {
  // The highlighted fact is what you want to recall — it becomes the ANSWER;
  // the user frames the question that should bring it to mind. The modal
  // shows exactly what was captured (rendered, images included) so there's
  // no doubt about the selection, and gives a proper textarea to write in.
  const answer = String(markdown || "").trim();
  if (!answer || !el.frameCardModal) return;

  el.frameCardModal.hidden = false;
  lockPageScroll();
  renderMarkdown(el.frameCardAnswerPreview, answer, true);
  el.frameCardQuestionInput.value = "";
  requestAnimationFrame(() => el.frameCardQuestionInput.focus());

  const cleanup = (confirmed) => {
    el.frameCardModal.hidden = true;
    unlockPageScroll();
    el.frameCardAddBtn.onclick = null;
    el.frameCardCancelBtn.onclick = null;
    el.frameCardQuestionInput.onkeydown = null;
    if (!confirmed) return;
    const question = el.frameCardQuestionInput.value.trim();
    if (!question) {
      // Blank-question cards are dropped by loadDeckSnapshot on the next
      // load, so keeping one would silently lose it anyway.
      setStatus("Card not added — a question is required.", "error");
      return;
    }
    addCardFromNotes(question, answer, noteAnchor);
  };
  el.frameCardAddBtn.onclick = () => cleanup(true);
  el.frameCardCancelBtn.onclick = () => cleanup(false);
  el.frameCardQuestionInput.onkeydown = (e) => {
    // Plain Enter inserts a newline (questions can be multi-line);
    // Ctrl/Cmd+Enter confirms, Escape cancels.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); cleanup(true); }
    if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
  };
}

// Strip markdown syntax down to the plain text a reader sees — used both to
// build a searchable anchor snippet and to match a card's answer against the
// rendered notes for the content fallback.
export function notesAnchorPlainText(src) {
  return String(src || "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, "").replace(/```/g, "")) // code fences → inner text
    .replace(/`([^`]*)`/g, "$1")                 // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")        // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // links → label
    .replace(/\{\{|\}\}/g, "")                   // cloze braces
    // Highlights are literal <mark>…</mark> pairs living in the markdown, so any
    // snippet taken from highlighted text carries the tags. They have to go
    // BEFORE the emphasis rule below, which eats a tag's ">" and leaves
    // "<markAlpha beta</mark" — a needle that can never appear in the rendered
    // text, so every jump built from it failed. Deliberately mark tags only, not
    // a general tag strip: prose containing "a < b" must survive untouched.
    .replace(/<\/?mark(?:\s[^>]*)?>/g, "")       // highlight tags
    .replace(/[*_~>#]+/g, "")                    // inline emphasis / heading / quote markers
    .replace(/\s+/g, " ")
    .trim();
}

// Snapshot of where the current NOTES selection sits, captured while the
// selection is still live. Returns null for a selection made anywhere other
// than the notes surface (so cards framed from a card face aren't note-linked).
export function captureNotesAnchor() {
  const notes = state.notes || "";
  if (!notes.trim()) return null;
  const notesTarget = SELECTION_TARGETS[0]; // { name: "notes", ... }
  if (state.viewMode !== "notes") return null;

  // Raw editor: exact character offsets are available directly.
  if (isTargetEditing(notesTarget)) {
    const { selectionStart, selectionEnd } = notesTarget.edit;
    if (selectionStart === selectionEnd) return null;
    const source = notes.slice(selectionStart, selectionEnd);
    const text = notesAnchorPlainText(source);
    if (!source.trim() && !text) return null;
    return { offset: selectionStart, source: source.slice(0, 400), text: text.slice(0, 400) };
  }

  // Rendered view: locate the selection back in the markdown source for an
  // offset hint; the plain text is the reliable key for re-finding it.
  const range = notesSelectionRange(notesTarget);
  if (!range) return null;
  const sel = renderedSelectionStrings(notesTarget.view);
  const plain = (range.toString() || (sel && sel.asText) || "").trim();
  let offset = null;
  let source = "";
  if (sel) {
    const loc = locateSelectionInSource(notes, sel);
    if (loc) {
      offset = loc.idx;
      source = notes.slice(loc.idx, loc.end);
    }
  }
  if (!plain && !source) return null;
  return { offset, source: source.slice(0, 400), text: plain.slice(0, 400) };
}

// Like captureNotesAnchor, but tags the anchor with the deck the notes belong
// to — so a card stored in a DIFFERENT deck (a quick_notes pin) can navigate
// back to the right deck first before searching its notes.
export function captureSourceAnchor() {
  const anchor = captureNotesAnchor();
  if (!anchor) return null;
  anchor.deckLocalId = state.localDeckId || null;
  anchor.deckId = state.deckId || null;
  anchor.deckTitle = state.deckTitle || "";
  return anchor;
}

// The note anchor to use for a card: its stored anchor, or a content fallback
// when the card's answer text still appears in the notes. Returns null when
// there's nothing to link to.
export function resolveCardNoteAnchor(card) {
  if (!card) return null;
  const stored = card.noteAnchor;
  if (stored && (stored.text || stored.source)) {
    // A cross-deck anchor (e.g. a quick_notes pin) points at ANOTHER deck's
    // notes — trust it unconditionally; jumpToNoteForCurrentCard loads that
    // deck before searching. A same-deck anchor only earns the button when this
    // deck actually has notes to jump into.
    if (stored.deckLocalId || stored.deckId) return stored;
    return (state.notes || "").trim() ? stored : null;
  }
  // Content fallback (same deck only): the answer's text still sits in the notes.
  const notes = state.notes || "";
  if (!notes.trim()) return null;
  const plain = notesAnchorPlainText(card.answer);
  if (plain.length < 12) return null;
  if (notesAnchorPlainText(notes).includes(plain)) return { offset: null, source: "", text: plain };
  return null;
}

export function cardHasNoteLink(card) {
  return Boolean(resolveCardNoteAnchor(card));
}

// Character index of the anchor within raw state.notes (for raw-editor jumps),
// or null if it can't be found.
export function resolveRawNoteIndex(anchor) {
  const notes = state.notes || "";
  const needle = anchor.source || anchor.text;
  if (!needle) return null;
  if (anchor.offset != null && notes.slice(anchor.offset, anchor.offset + needle.length) === needle) {
    return anchor.offset;
  }
  let idx = notes.indexOf(needle);
  if (idx === -1 && anchor.text) idx = notes.indexOf(anchor.text);
  return idx === -1 ? null : idx;
}

// Build a DOM Range spanning the anchor text inside the rendered notes view, so
// it can be scrolled to and flashed. Falls back to a shorter prefix when the
// full selection can't be matched verbatim (e.g. the notes were edited since).
// How many pages either side of the estimate the paged text search covers.
// Wider than it needs to be for a good estimate, because being one page short
// means falling through to "not found" and a visible failure, while being two
// pages wide costs a TreeWalker over a few extra screens of a note that is at
// most NOTES_PAGED_MAX_CHARS long by construction.
export const PAGED_SEARCH_PAGES = 2;

export function findRenderedNoteRange(anchor, offset = null) {
  const view = el.notesView;
  const needle = (anchor.text || "").trim();
  if (!view || !needle) return null;

  // When the caller knows the raw offset (the raw→rendered toggle, or a
  // jump-to-anchor), scope the text walk to a window around the estimated
  // scroll position instead of flattening the whole (potentially enormous)
  // document. The window is wide enough to absorb the proportional estimate's
  // error on a note whose block heights are far from uniform. Without an
  // offset (rare), fall back to a full walk.
  // In paged mode every one of those numbers is a lie: scrollTop is always 0 and
  // scrollHeight === clientHeight, so `centerDoc` is a fraction of ONE viewport
  // and `half` (>= 4000) swallows it whole. The window degenerated to "the whole
  // document", the loop below never broke out of it, and indexOf then took the
  // FIRST occurrence of the phrase anywhere in the note — which is precisely the
  // wrong-copy failure the window exists to prevent. The binary search was
  // invalid there too: paged document order runs along X, so block `bottom`
  // values are not monotonic.
  //
  // The paged equivalent of "a band of pixels around the estimate" is "a band of
  // PAGES around it", which pageWindow below computes instead.
  const paged = offset != null && isNotesPaged();
  let winTopView = -Infinity;
  let winBottomView = Infinity;
  if (offset != null && !paged && state.notes) {
    const fraction = Math.max(0, Math.min(1, offset / state.notes.length));
    const centerDoc = fraction * view.scrollHeight;
    const half = Math.max(4000, view.clientHeight * 2);
    const viewTop = view.getBoundingClientRect().top;
    winTopView = viewTop + (centerDoc - half) - view.scrollTop;
    winBottomView = viewTop + (centerDoc + half) - view.scrollTop;
  }

  const segments = [];
  let full = "";
  const collect = (node) => {
    segments.push({ node, start: full.length });
    full += node.textContent;
  };
  const collectAll = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) collect(node);
  };
  // Where each collected BLOCK begins in `full`, and roughly where it sits in
  // the markdown source — so a needle that occurs more than once can be
  // resolved to the copy nearest the position asked for. See pickMatch below.
  const blockMarks = [];
  const collectBlock = (block) => {
    blockMarks.push({ start: full.length, approx: approximateRawOffsetForBlock(view, state.notes || "", block) });
    collectAll(block);
  };

  if (paged) {
    // Pages, like blocks, are non-decreasing in document order, so the same
    // binary-search-then-walk shape applies — just on the other axis. A note in
    // paged mode is at most NOTES_PAGED_MAX_CHARS, so the band can be generous.
    const fraction = Math.max(0, Math.min(1, offset / (state.notes || " ").length));
    const centre = Math.round(fraction * Math.max(0, notesPageCount() - 1));
    const lo = centre - PAGED_SEARCH_PAGES;
    const hi = centre + PAGED_SEARCH_PAGES;
    const blocks = notesTopLevelBlocks(view);
    const pageOf = (i) => notesPageForElement(blocks[i]);
    let low = 0;
    let high = blocks.length - 1;
    let first = blocks.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (pageOf(mid) < lo) low = mid + 1;
      else { first = mid; high = mid - 1; }
    }
    for (let i = first; i < blocks.length; i += 1) {
      if (blocks[i].nodeType !== 1) continue;
      if (pageOf(i) > hi) break;
      collectBlock(blocks[i]);
    }
  } else if (offset != null) {
    // Windowed: only descend into top-level blocks whose vertical span
    // overlaps the window, so a huge note isn't flattened in full.
    //
    // Blocks are in document order, so the window is a contiguous run and its
    // first member can be binary searched for instead of found by testing every
    // block from the top. That matters because these are `content-visibility:
    // auto` blocks: reading a rect forces the browser to lay one out, so the
    // old linear sweep un-skipped the entire document just to decide which
    // handful of blocks to read — on every toggle and every anchor jump.
    const blocks = notesTopLevelBlocks(view);
    const topOf = (i) => blocks[i].getBoundingClientRect().top;
    let low = 0;
    let high = blocks.length - 1;
    let first = blocks.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (blocks[mid].getBoundingClientRect().bottom < winTopView) {
        low = mid + 1;
      } else {
        first = mid;
        high = mid - 1;
      }
    }
    for (let i = first; i < blocks.length; i += 1) {
      const block = blocks[i];
      if (block.nodeType !== 1) continue;
      if (topOf(i) > winBottomView) break;
      collectBlock(block);
    }
  } else {
    collectAll(view);
  }
  if (!segments.length) return null;

  // The NEAREST occurrence, not the first one.
  //
  // Taking the first match in the window is only right when the needle is
  // unique, and in real prose it very often is not — a caret resting
  // mid-paragraph gives a needle like "…to give the block a realistic height",
  // which recurs. Measured on a 390px phone before this: returning from raw mode
  // landed 32 paragraphs early at every scroll position, on exactly that needle.
  // The window narrows the field but its left edge is not the answer; the same
  // lesson is recorded for the source-side search in matchSnippetInSource.
  //
  // "Nearest" is measured in MARKDOWN offsets: each collected block knows
  // roughly where it starts in the source (approximateRawOffsetForBlock), so a
  // match inherits the estimate of the block it fell in and the one closest to
  // the offset asked for wins. With no offset, or no estimates, this degrades to
  // the first match — which is what it always did.
  const pickMatch = (text) => {
    if (!text) return -1;
    const first = full.indexOf(text);
    if (first === -1 || offset == null || !blockMarks.length) return first;
    let best = first;
    let bestDelta = Infinity;
    for (let at = first; at !== -1; at = full.indexOf(text, at + 1)) {
      let mark = null;
      for (let i = 0; i < blockMarks.length && blockMarks[i].start <= at; i += 1) mark = blockMarks[i];
      if (mark?.approx == null) continue;
      const delta = Math.abs(mark.approx - offset);
      if (delta < bestDelta) { bestDelta = delta; best = at; }
    }
    return best;
  };

  let matchStart = pickMatch(needle);
  let matchLen = needle.length;
  if (matchStart === -1) {
    // The rendered text collapses source whitespace differently — retry with a
    // short prefix, which is far likelier to survive verbatim.
    const prefix = needle.slice(0, 40).trim();
    matchStart = pickMatch(prefix);
    if (matchStart === -1) return null;
    matchLen = prefix.length;
  }
  const matchEnd = matchStart + matchLen;

  const locate = (pos) => {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (pos >= segments[i].start) {
        return { node: segments[i].node, offset: pos - segments[i].start };
      }
    }
    return { node: segments[0].node, offset: 0 };
  };

  try {
    const s = locate(matchStart);
    const e = locate(matchEnd);
    const range = document.createRange();
    range.setStart(s.node, Math.min(s.offset, s.node.textContent.length));
    range.setEnd(e.node, Math.min(e.offset, e.node.textContent.length));
    return range;
  } catch (_) {
    return null;
  }
}

// Scroll #notesView to the block containing a given RAW markdown offset — the
// reverse of findRawOffsetForRenderedPoint. Used when leaving raw-edit mode
// (the offset is a caret/scroll position in the textarea) and by the
// cross-device resume feature. Built on findRenderedNoteRange (a text search
// over the rendered DOM) rather than block-index arithmetic, because
// preprocessSpecialBlocks changes string length/structure between raw
// state.notes and what actually gets lexed into rendered blocks — an index
// computed one way wouldn't line up with the other.
// A rough proportional estimate of where `offset` sits in #notesView's
// scroll range — not the final answer, just enough to centre the windowed
// text search (findRenderedNoteRange) near the target. The precise landing
// spot still comes from that text search; the estimate only makes the search
// cheap on a long note (a slice of the DOM instead of the whole thing).
export function estimateNotesScrollForOffset(offset) {
  if (!el.notesView || !Number.isFinite(offset) || !state.notes) return;
  const fraction = Math.max(0, Math.min(1, offset / state.notes.length));
  // Paged mode has no scrollHeight to take a fraction of — the note runs
  // sideways — so the same proportional guess becomes a page number.
  if (estimateNotesPageForFraction(fraction)) return;
  markProgrammaticNotesScroll();
  // Of the SCROLLABLE range, not of scrollHeight. A fraction of the full height
  // overshoots by up to one viewport (fraction 1 asks for a scrollTop the
  // scroller cannot reach and clamps, fraction 0.5 lands half a screen low), and
  // this estimate exists to centre a text-search window on the target.
  const range = Math.max(0, el.notesView.scrollHeight - el.notesView.clientHeight);
  el.notesView.scrollTop = fraction * range;
}

// Puts `block` where rawOffsetForCurrentNotesScroll SAMPLES from, so that a
// round trip is the identity. This used to be scrollIntoView({block:"center"}),
// which centred the target while the sampler read from near the top — so every
// raw<->rendered toggle slid the note by about half a viewport, compounding in
// whichever direction you happened to be toggling.
export function scrollNotesBlockToReadingLine(block, smooth) {
  if (!block || !el.notesView) return;
  // In paged mode there is no reading line to put anything on: the block is
  // either on the page you are looking at or it is not. Turn to its page.
  if (revealInPagedNotes(block)) return;
  const view = el.notesView;
  const delta = block.getBoundingClientRect().top - view.getBoundingClientRect().top;
  const target = view.scrollTop + delta - notesReadingLineOffset(view.clientHeight);
  markProgrammaticNotesScroll(smooth ? 800 : NOTES_PROGRAMMATIC_SCROLL_MS);
  view.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
}

// ── Aiming at a moving target ───────────────────────────────────────────────
//
// A long note does not know its own height until you get there: diagrams below
// the fold are only drawn as they approach the viewport, images only load then,
// content-visibility chunks swap an estimated height for a real one, and each
// one that arrives pushes everything under it down. So aiming ONCE at where the
// target looks like it is can land thousands of pixels off.
//
// The loop therefore runs to CONVERGENCE rather than to a fixed count. It stops
// when the residual is small enough, when two corrections in a row fail to
// improve it (heights that will not settle — a lazily-loading image below the
// fold — must not spin forever), or when the budget expires.
//
// `residual()` returns the signed pixels still to travel: add it to scrollTop
// and the target sits where it belongs. Returning null abandons the aim, which
// is how a caller says "the thing I was pointing at has left the document".
//
// Shared by the TOC heading jump (which wants the target at the top, under a
// small gap) and the anchor/highlight jump (which wants it centred) — they
// differ only in what they measure, so only `residual` differs.
export const NOTES_AIM_SETTLE_PX = 4;

export const NOTES_AIM_SETTLE_MS = 110;

export async function convergeNotesScroll(residual, budgetMs) {
  const view = el.notesView;
  if (!view) return;
  const aim = (delta, behavior) => {
    markProgrammaticNotesScroll(behavior === "smooth" ? 800 : NOTES_PROGRAMMATIC_SCROLL_MS);
    view.scrollTo({ top: Math.max(0, view.scrollTop + delta), behavior });
  };
  const first = residual();
  if (first == null) return;
  aim(first, "smooth");
  const until = performance.now() + budgetMs;
  let best = Infinity;
  let stalled = 0;
  while (performance.now() < until) {
    // A frame first so the scroll and any chunk that just realised are laid out,
    // then a short settle for the smooth scroll and lazily-arriving content.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, NOTES_AIM_SETTLE_MS)));
    const delta = residual();
    if (delta == null) return;
    const left = Math.abs(delta);
    if (left <= NOTES_AIM_SETTLE_PX) return;
    // Not improving: one more correction is worth trying (the first measurement
    // after a smooth scroll is taken mid-flight), two in a row is a stalemate.
    if (left >= best - 1) {
      stalled += 1;
      if (stalled >= 2) return;
    } else {
      stalled = 0;
    }
    best = Math.min(best, left);
    aim(delta, "auto");
  }
}

// How long the anchor/highlight jump keeps correcting. Shorter than the TOC's
// budget: a heading jump usually crosses the whole note, while this one is
// often already close.
export const NOTE_JUMP_BUDGET_MS = 1200;

// How far `range` still is from the middle of the notes viewport, or null if it
// has stopped being measurable.
//
// Measured through withChunkRendered on the range's own BLOCK, because on a
// chunked note the containment sits on the wrapper: a target inside a skipped
// chunk answers with its chunk's box, the same answer all 40 of its neighbours
// give. The range's rect is preferred over the block's — a paragraph that flows
// across a column break or runs several screens long would otherwise centre its
// own midpoint rather than the highlighted words — with the block as the
// fallback for a range the DOM no longer resolves.
export function noteRangeCenterResidual(range, block, view) {
  const target = block || view;
  if (!view || !target?.isConnected) return null;
  return withChunkRendered(target, view, () => {
    const rangeRect = range?.getBoundingClientRect?.();
    const rect = rangeRect && (rangeRect.height || rangeRect.width) ? rangeRect : target.getBoundingClientRect();
    if (!rect.height && !rect.width) return null;
    const viewTop = view.getBoundingClientRect().top;
    return rect.top - viewTop - Math.max(0, (view.clientHeight - rect.height) / 2);
  });
}

export function blockForRange(range) {
  if (!range) return null;
  const startEl = range.startContainer.nodeType === Node.TEXT_NODE
    ? range.startContainer.parentElement
    : range.startContainer;
  return startEl?.closest?.(NOTES_BLOCK_SELECTOR) || startEl;
}

export function scrollRenderedNotesToRawOffset(offset, { smooth = true } = {}) {
  if (offset == null || !el.notesView || el.notesView.hidden) return;
  const notes = state.notes || "";
  // Snap BACK to the start of the line before taking the needle.
  //
  // The needle used to be "the 60 characters after the caret", and a caret
  // resting mid-paragraph makes that a slice of ordinary prose — which in a
  // real note recurs. Measured on a 390px phone: coming back from raw mode
  // landed 32 paragraphs early at every scroll position, because the needle was
  // "rose to give the block a realistic heigh" and the search took a different
  // copy of it. A line start is where a markdown paragraph, heading or list item
  // begins, so the needle taken from there is the distinctive part of the text
  // rather than its middle.
  const lineStart = notes.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const from = Number.isFinite(lineStart) && lineStart >= 0 && lineStart <= offset ? lineStart : offset;
  const forward = notes.slice(from, from + 80).trim();
  const backward = notes.slice(Math.max(0, offset - 60), offset).trim();
  const needle = forward || backward;
  if (!needle) return;

  // No proportional pre-scroll here any more. It used to run unconditionally,
  // "to centre the windowed text search" — but findRenderedNoteRange derives its
  // window from the offset's fraction of scrollHeight in DOCUMENT space and
  // subtracts scrollTop back out, so where the view happens to be scrolled makes
  // no difference to what it searches. The pre-scroll bought nothing and cost a
  // visible jump: the toggle moved once to a proportional guess and then again
  // to the real target, which is what made it feel broken even on a short note
  // where the target had never left the screen.
  const attempt = (retriesLeft) => {
    const block = blockForRange(findRenderedNoteRange({ text: needle }, offset));
    if (block) {
      scrollNotesBlockToReadingLine(block, smooth);
      return;
    }
    // Not found in the window — heights are still settling (images loading), so
    // the offset→position estimate the window was built from was off. Fall back
    // to one full-document search before giving up rather than looping.
    if (retriesLeft > 0) {
      const full = blockForRange(findRenderedNoteRange({ text: needle }));
      if (full) {
        scrollNotesBlockToReadingLine(full, smooth);
        return;
      }
      requestAnimationFrame(() => attempt(retriesLeft - 1));
    }
  };
  requestAnimationFrame(() => attempt(2));
}

// Put a rendered range on screen and (optionally) flash it. Shared by the
// anchor-text jump below and the exact-<mark> jump above it, which differ only
// in how they find the range.
//
// Centred, unlike the raw<->rendered restore: this is an explicit jump to
// somewhere you weren't, so putting the target in the middle of the screen is
// what you want. Restoring a reading position is the case that has to land on
// the reading line instead.
export function revealRenderedNoteRange(range, { flash = true, smooth = true } = {}) {
  const block = blockForRange(range);
  markProgrammaticNotesScroll(smooth ? 800 : NOTES_PROGRAMMATIC_SCROLL_MS);
  // scrollIntoView WOULD move a paged view — it scrolls the nearest scrollable
  // ancestor, and here that scrolls sideways — but it stops as soon as the
  // target is visible, which leaves the reader mid-page with a column sliced
  // down the middle of the screen. Land on the page boundary instead.
  //
  // From the RANGE, not from `block`. A block that flows across a column break
  // reports the union of its fragments, so paging by the block sent every jump
  // whose target sat in the tail of such a paragraph to the previous page, with
  // the thing it was pointing at off-screen.
  if (!revealRangeInPagedNotes(range)) {
    // Centre it, then KEEP centring it. This used to be a single
    // scrollIntoView({block:"center"}), which aims once against heights that are
    // still estimates below the fold — and on a chunked note it aimed at a
    // target whose chunk had not laid out, where it and all 40 of its
    // neighbours report the same box. Between them that is the "Go to takes me
    // near the highlight but not to it" report. Deliberately not awaited: every
    // caller reads the boolean to decide whether to keep retrying, and the aim
    // has already been issued synchronously by the time this returns.
    convergeNotesScroll(() => noteRangeCenterResidual(range, block, el.notesView), NOTE_JUMP_BUDGET_MS);
  }
  if (!flash) return true;
  // The browser's own selection highlight makes the exact span obvious; the
  // block flash draws the eye there first.
  //
  // Declared as OURS before it is made. This is a real Selection and it fires
  // `selectionchange` like any other, so the floating formatting pill used to
  // appear over a span the reader never selected — every "Go to" from the
  // Highlights panel, every card's "Go to notes", every Quick Notes jump ended
  // with a toolbar in the way of the thing you had just asked to be shown.
  markProgrammaticNotesSelection();
  const sel = window.getSelection();
  sel?.removeAllRanges();
  try { sel?.addRange(range); } catch (_) {}
  if (block && block.classList) {
    block.classList.add("note-anchor-flash");
    setTimeout(() => block.classList.remove("note-anchor-flash"), 1800);
  }
  return true;
}

// Jump straight to the Nth <mark> in the rendered notes, no text search at all.
//
// A highlight is a literal <mark>…</mark> pair in state.notes, so the Highlights
// panel already knows each entry's ordinal among all the marks in the source —
// and marked/DOMPurify preserve document order, so the Nth mark in the source is
// the Nth <mark> element in the view. That makes the jump exact, which the text
// search fundamentally cannot be: it takes the FIRST occurrence of the
// highlighted words inside a several-thousand-pixel window, so highlighting a
// phrase that recurs nearby landed on the wrong copy of it.
//
// `markCount` is the gate. Marks are only produced from a selection, which never
// wraps fenced code — but nothing stops a reader typing <mark> inside a fence in
// the raw editor, and that one renders as literal TEXT rather than an element.
// The source scan counts it and the DOM doesn't, so every ordinal after it would
// be off by one. When the two counts disagree we know nothing about the mapping
// and hand back false so the caller falls back to the text search.
export function revealNoteMark(locator, options) {
  const view = el.notesView;
  if (!view || view.hidden || !locator) return false;
  const { markIndex, markCount } = locator;
  if (!Number.isFinite(markIndex) || markIndex < 0) return false;
  const marks = view.querySelectorAll("mark");
  if (!Number.isFinite(markCount) || marks.length !== markCount) return false;
  const node = marks[markIndex];
  if (!node) return false;
  let range;
  try {
    range = document.createRange();
    range.selectNodeContents(node);
  } catch (_) {
    return false;
  }
  return revealRenderedNoteRange(range, options);
}

// Scroll to the anchor and briefly flash it. Handles both rendered and raw
// notes. Returns true when it found and revealed the spot. `flash`/`smooth`
// default to true (every existing caller — a deliberate jump-to-origin click)
// so only an ambient landing (cross-device reading-position resume on load)
// needs to opt out: no flash for something the reader didn't ask to jump to,
// no animated scroll on every deck open.
//
// `locator` is the optional exact-<mark> shortcut described above; the anchor is
// still required, because it's what the raw-editor branch and the fallback text
// search work from.
export function revealNoteAnchor(anchor, { flash = true, smooth = true } = {}, locator = null) {
  const notesTarget = SELECTION_TARGETS[0];
  if (isTargetEditing(notesTarget)) {
    const idx = resolveRawNoteIndex(anchor);
    if (idx == null) return false;
    const len = Math.max(1, (anchor.source || anchor.text || "").length);
    const edit = notesTarget.edit;
    edit.focus();
    edit.setSelectionRange(idx, idx + len);
    // No flash in raw mode: the browser's own selection highlight over
    // setSelectionRange's range already marks the spot. (`flash` still governs
    // the rendered branch below, where there is no selection to see.)
    scrollTextareaToOffset(edit, idx);
    return true;
  }

  if (revealNoteMark(locator, { flash, smooth })) return true;

  const range = findRenderedNoteRange(anchor, anchor.offset);
  if (!range) return false;
  return revealRenderedNoteRange(range, { flash, smooth });
}

// ── Resuming where you were reading ────────────────────────────────────────
//
// How long an ambient resume keeps trying, and how often. Both are far beyond
// what a deliberate jump needs, and deliberately so: a book is STREAMED into the
// document (see streamRenderedBlocks) and its chunk heights settle after that
// again, so for the first few seconds the block the reader wants may not exist
// yet. The old loop gave up after 8 tries at 120ms — about a second — and, being
// an ambient landing, it gave up SILENTLY. On the notes this feature exists for,
// it therefore did nothing at all, every time.
export const NOTE_RESUME_BUDGET_MS = 8000;

export const NOTE_RESUME_RETRY_MS = 150;

// A resume is the app moving the reader somewhere they did not ask to go. That
// is welcome as an opening position and unwelcome the moment they start reading,
// so anything that says "I am here now" ends it.
export const READER_INTERRUPTION_EVENTS = ["pointerdown", "touchstart", "wheel", "keydown"];

export function watchForReaderInterruption() {
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    cancel();
  };
  const cancel = () => {
    READER_INTERRUPTION_EVENTS.forEach((type) => document.removeEventListener(type, stop, true));
  };
  // Input events only, deliberately NOT the scroll event. A note that is still
  // streaming moves its own scrollTop as blocks land above the viewport and as
  // content-visibility chunks swap an estimate for a real height, and every one
  // of those fires `scroll` — so watching for scrolls would have this abandon
  // the resume within a frame or two of starting it, on exactly the long notes
  // it exists for. isProgrammaticNotesScroll cannot rescue that either: its
  // window is 250ms and the settling goes on for seconds. A finger or a wheel
  // is unambiguous.
  READER_INTERRUPTION_EVENTS.forEach((type) => document.addEventListener(type, stop, { capture: true, passive: true }));
  return { interrupted: () => interrupted, cancel };
}

// Switch to the notes view (if needed) and reveal the anchor. setViewMode
// re-renders the notes markdown asynchronously, so retry across a few frames
// before giving up. Two rAFs cover the initial render; the timeout loop is a
// belt-and-braces fallback for slower renders / a just-loaded deck. `options`
// (flash/smooth) is threaded straight through to revealNoteAnchor, as is
// `locator` (the exact-<mark> shortcut used by the Highlights panel).
//
// `options.resume` marks an ambient landing — see the block above.
//
// `options.patient` asks for the SAME generous retry budget as a resume
// (NOTE_RESUME_BUDGET_MS, re-aimed on every pass) without the rest of what
// makes a resume a resume — it still reports failure with a status message,
// and a touch/scroll doesn't cancel it, because this IS the deliberate
// action the reader asked for (the Highlights panel's "Go to →"). Without
// this, revealNoteMark's exact <mark>-ordinal path (see below) silently gives
// up the instant the target's block hasn't streamed into the DOM yet — which
// on a large book is routine for a mark near the end — and falls back to a
// text search whose windowed estimate can be wrong on an unstreamed note.
// Patience is what lets the exact path win once streaming catches up instead
// of settling for that guess after ~1s.
export function scheduleNoteJump(anchor, options, locator = null) {
  if (state.viewMode !== "notes") setViewMode("notes");
  const resume = Boolean(options?.resume);
  const patient = resume || Boolean(options?.patient);
  let estimatedOnce = false;
  const until = performance.now() + NOTE_RESUME_BUDGET_MS;
  const reader = resume ? watchForReaderInterruption() : null;
  const done = () => { reader?.cancel(); };
  const attempt = (retries) => {
    // The reader took over. Their position is the real one now.
    if (reader?.interrupted()) return;
    if (revealNoteAnchor(anchor, options, locator)) { done(); return; }
    // findRenderedNoteRange (inside revealNoteAnchor) does a text search over
    // the rendered DOM. Nudge toward a proportional estimate so the windowed
    // search is centred near the target before retrying.
    //
    // For a resume (and a patient jump) this is also the landing itself, and
    // it is re-aimed on every pass rather than once: the note is still
    // streaming, so its height — and therefore where a given fraction of it
    // sits — changes under us. That is what "land straight away, then
    // correct" means here. The reader is put roughly in the right chapter
    // within a frame or two and converges on the exact paragraph as the note
    // settles, instead of sitting at the top of a book waiting for a search
    // that has nothing to search yet.
    if (Number.isFinite(anchor?.offset) && !isTargetEditing(SELECTION_TARGETS[0]) && (patient || !estimatedOnce)) {
      estimatedOnce = true;
      // By BLOCK where the block cache can answer, by pixel fraction only as a
      // fallback. See notesBlockForRawOffset: a fraction of scrollHeight is a
      // fraction of a height that is mostly estimates on a note nobody has
      // scrolled through yet, and on a 2.6MB book that put the landing half a
      // million pixels from where the reader actually was.
      const block = notesBlockForRawOffset(el.notesView, state.notes || "", anchor.offset);
      if (block) scrollNotesBlockToReadingLine(block, false);
      else estimateNotesScrollForOffset(anchor.offset);
    }
    if (patient) {
      if (performance.now() < until) setTimeout(() => attempt(0), NOTE_RESUME_RETRY_MS);
      else {
        done();
        if (resume) {
          // Never a toast — nobody asked for this jump — but not silent
          // either. "The resume quietly did nothing" was impossible to tell
          // from "there was nothing to resume to".
          console.warn("Reading position not found in the rendered note", anchor?.offset);
        } else if (!options || options.flash !== false) {
          setStatus("Couldn't find that spot in the notes — it may have been edited.", "info");
        }
      }
      return;
    }
    if (retries > 0) setTimeout(() => attempt(retries - 1), 120);
    else if (!options || options.flash !== false) {
      setStatus("Couldn't find that spot in the notes — it may have been edited.", "info");
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(() => attempt(8)));
}

// True when the currently-loaded deck is the one this anchor came from (so no
// deck switch is needed before jumping).
export function onAnchorSourceDeck(anchor) {
  if (anchor.deckLocalId) return anchor.deckLocalId === state.localDeckId;
  if (anchor.deckId) return anchor.deckId === state.deckId;
  return true; // no deck tag = same deck by construction (in-deck make-card)
}

export async function jumpToNoteForCurrentCard() {
  const card = state.cards[state.current];
  const anchor = resolveCardNoteAnchor(card);
  if (!anchor) {
    setStatus("This card isn't linked to a spot in the notes.", "error");
    return;
  }

  if (onAnchorSourceDeck(anchor)) {
    scheduleNoteJump(anchor);
    return;
  }

  // Cross-deck anchor (quick_notes pin): open the source deck first, then jump.
  // The deck loaders record the back history themselves — nothing to do here.
  setStatus("Opening the source deck…");
  if (anchor.deckLocalId && (await loadDeckFromLibrary(anchor.deckLocalId))) {
    scheduleNoteJump(anchor);
    return;
  }
  if (anchor.deckId && supabaseClient && navigator.onLine) {
    loadWebDeck(anchor.deckId)
      .then(() => scheduleNoteJump(anchor))
      .catch(() => setStatus("Couldn't open the source deck for this note.", "error"));
    return;
  }
  setStatus("Couldn't open the source deck for this note — it isn't available on this device.", "error");
}
