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
import { locateSelectionInSource, renderedSelectionStrings } from "../format/locate-selection.js?v=__BUILD__";
import { loadDeckFromLibrary, scheduleDeckAutosave, state } from "../main.js?v=__BUILD__";
import { scrollTextareaToOffset } from "./caret.js?v=__BUILD__";
import { NOTES_PROGRAMMATIC_SCROLL_MS, markProgrammaticNotesScroll } from "./notes-view.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR } from "./raw-offset.js?v=__BUILD__";
import { notesReadingLineOffset } from "./scroll-anchor.js?v=__BUILD__";
import { SELECTION_TARGETS, isTargetEditing, notesSelectionRange } from "./selection.js?v=__BUILD__";
import { renderMarkdown } from "../render/block-cache.js?v=__BUILD__";
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
  let winTopView = -Infinity;
  let winBottomView = Infinity;
  if (offset != null && state.notes) {
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

  if (offset != null) {
    // Windowed: only descend into top-level blocks whose vertical span
    // overlaps the window, so a huge note isn't flattened in full.
    //
    // Blocks are in document order, so the window is a contiguous run and its
    // first member can be binary searched for instead of found by testing every
    // block from the top. That matters because these are `content-visibility:
    // auto` blocks: reading a rect forces the browser to lay one out, so the
    // old linear sweep un-skipped the entire document just to decide which
    // handful of blocks to read — on every toggle and every anchor jump.
    const blocks = view.children;
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
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) collect(node);
    }
  } else {
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) collect(node);
  }
  if (!segments.length) return null;

  let matchStart = full.indexOf(needle);
  let matchLen = needle.length;
  if (matchStart === -1) {
    // The rendered text collapses source whitespace differently — retry with a
    // short prefix, which is far likelier to survive verbatim.
    const prefix = needle.slice(0, 40).trim();
    matchStart = prefix ? full.indexOf(prefix) : -1;
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
  markProgrammaticNotesScroll();
  el.notesView.scrollTop = fraction * el.notesView.scrollHeight;
}

// Puts `block` where rawOffsetForCurrentNotesScroll SAMPLES from, so that a
// round trip is the identity. This used to be scrollIntoView({block:"center"}),
// which centred the target while the sampler read from near the top — so every
// raw<->rendered toggle slid the note by about half a viewport, compounding in
// whichever direction you happened to be toggling.
export function scrollNotesBlockToReadingLine(block, smooth) {
  if (!block || !el.notesView) return;
  const view = el.notesView;
  const delta = block.getBoundingClientRect().top - view.getBoundingClientRect().top;
  const target = view.scrollTop + delta - notesReadingLineOffset(view.clientHeight);
  markProgrammaticNotesScroll(smooth ? 800 : NOTES_PROGRAMMATIC_SCROLL_MS);
  view.scrollTo({ top: Math.max(0, target), behavior: smooth ? "smooth" : "auto" });
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
  const forward = notes.slice(offset, offset + 60).trim();
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
  (block || el.notesView).scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  if (!flash) return true;
  // The browser's own selection highlight makes the exact span obvious; the
  // block flash draws the eye there first.
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

// Switch to the notes view (if needed) and reveal the anchor. setViewMode
// re-renders the notes markdown asynchronously, so retry across a few frames
// before giving up. Two rAFs cover the initial render; the timeout loop is a
// belt-and-braces fallback for slower renders / a just-loaded deck. `options`
// (flash/smooth) is threaded straight through to revealNoteAnchor, as is
// `locator` (the exact-<mark> shortcut used by the Highlights panel).
export function scheduleNoteJump(anchor, options, locator = null) {
  if (state.viewMode !== "notes") setViewMode("notes");
  let estimatedOnce = false;
  const attempt = (retries) => {
    if (revealNoteAnchor(anchor, options, locator)) return;
    // findRenderedNoteRange (inside revealNoteAnchor) does a text search over
    // the rendered DOM. Nudge toward a proportional estimate once so the
    // windowed search is centred near the target before retrying.
    if (!estimatedOnce && Number.isFinite(anchor?.offset) && !isTargetEditing(SELECTION_TARGETS[0])) {
      estimatedOnce = true;
      estimateNotesScrollForOffset(anchor.offset);
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
