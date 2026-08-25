// The place you are keeping — now written down by the sync rather than by a
// button of its own.
//
// ── Why there is no "Bookmark this spot" button any more ───────────────────
//
// There were two presses for one intention. This module knew where the reader
// was and pushed it (bookmarkCurrentSpot); reconcileAllDecks pushed everything
// else. Pressing one and then the other is the same sentence said twice — "save
// where I am" — so the sync says it, and the button is gone.
//
// What is left of the pair is the way BACK: #bookmarkGoBtn, and the rail row
// that stands in for it while focus mode has the header folded away. Something
// has to be able to take you there, and nothing else can.
//
// Stored at meta.bookmark — the same key it always used, which is what let
// mergeDeckMeta's `.at` rule and deckContentMatches carry on untouched. (A
// third reader of that key, pushBookmarkNow, is gone with the button: it was a
// narrow cloud write that existed to beat the deck push it was not part of, and
// the run that captures a bookmark now IS the run about to push it.)
//
// Surfaced on another device two ways: a one-time "jump there?"
// prompt right after the ambient same-device resume settles, and the persistent
// "go to bookmark" button for whenever that prompt is missed or dismissed.
//
// ── Two surfaces, one bookmark ─────────────────────────────────────────────
//
// It used to refuse anything but the notes view, which is exactly backwards for
// someone who reads papers: the Document view is where the reading happens. An
// anchor therefore comes in two shapes now — a character offset into the
// markdown, or a page and a fraction of it — and NOTHING downstream had to
// change to carry the second one. scheduleNoteJump's first branch already
// recognises `pdfPage` and switches views itself (src/notes/anchors.js), and
// mergeDeckMeta compares `.at` without ever looking inside the anchor
// (src/sync/document-sync.js).

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { scheduleNoteJump } from "./anchors.js?v=__BUILD__";
import { recordBookmarkPrompted, wasBookmarkPrompted } from "./bookmark-prompt-store.js?v=__BUILD__";
import { currentDeckKey, rawOffsetForCurrentNotesScroll } from "./scroll-anchor.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";

// Roughly the span of the text snippet an anchor already carries (trimNoteAnchor
// caps `text` at 300 chars) — "near" means the reader can already see the
// bookmarked text without scrolling.
//
// It answers two questions now, and they are the same question:
//
//   • should the cross-device prompt fire? A prompt on top of a silent ambient
//     resume that already landed there would be pure noise.
//   • should a sync move the bookmark at all? deckContentMatches treats a
//     changed meta.bookmark.at as real content (src/library/local-library.js),
//     so a bookmark that moves on every auto-sync means a full deck push every
//     cycle even when nobody read a word. Standing still must write nothing.
//
// One threshold rather than two, because "is this the same spot" has one
// answer and inventing a second constant would let them drift apart.
export const BOOKMARK_PROMPT_NEAR_CHARS = 500;

// The document half of the same threshold: the same page, and within half a
// page of it. A page is a whole screen on a phone, so "same page" alone would
// call the top and the bottom of one page the same spot.
export const BOOKMARK_NEAR_RATIO = 0.5;

// ── The boot race ──────────────────────────────────────────────────────────
//
// src/boot.js fires a sync 1200ms after launch, and the ambient same-device
// resume is still landing at that point. A capture then would read "the top of
// the note", write it over the real bookmark, and push it — losing the place
// the reader was keeping to a sync they never asked for.
//
// So a capture refuses until the resume for THIS deck has settled. There is no
// new hook for that: maybePromptBookmarkJump below is already called at exactly
// that moment, on both branches of the resume in deck-snapshot.js and
// web-decks.js — after a jump lands, and immediately when there was no position
// to resume to.
let resumeSettledForKey = null;

// ── Where the reader is, in whichever shape this surface uses ──────────────
export function currentSpotAnchor() {
  if (state.viewMode === "document") return documentSpotAnchor();
  if (state.viewMode === "notes") return notesSpotAnchor();
  return null;
}

function notesSpotAnchor() {
  if (!el.notesView || el.notesView.hidden) return null;
  const offset = rawOffsetForCurrentNotesScroll();
  if (offset == null) return null;
  const notes = state.notes || "";
  const text = notes.slice(offset, offset + 80).trim() || notes.slice(Math.max(0, offset - 80), offset).trim();
  const trimmed = trimNoteAnchor({ offset, source: notes.slice(offset, offset + 80), text });
  if (!trimmed) return null;
  // trimNoteAnchor drops `.at` (quick-notes pins don't want one) — re-add it
  // after trimming. Without this the bookmark would carry no timestamp at
  // all, and both cross-device ordering (mergeDeckMeta) and the prompt dedup
  // (bookmark-prompt-store) compare on exactly this field.
  return { ...trimmed, at: Date.now() };
}

// Read off meta.readingPosition rather than measured here.
//
// pdf-view.js's scheduleDocumentPositionSave already writes exactly this shape
// onto state.meta.readingPosition, synchronously, from the rAF-coalesced scroll
// listener in main.js — so the answer is current to the last scroll frame and
// asking for it again would be a second opinion about where the reader is. It
// also keeps this module out of src/documents/, which reaches back toward
// mark-menu.js through pdf-highlights.js; an import edge that way would be a
// cycle for a number that is already published.
//
// `offset` carries the page number for the same reason pdf-view.js gives: the
// stores and the prompt dedup want a finite `offset`, and `pdfPage`/`ratio` are
// what scheduleNoteJump's document branch actually reads.
function documentSpotAnchor() {
  if (!state.meta?.pdf) return null;
  const here = state.meta?.readingPosition;
  const page = Number(here?.pdfPage);
  if (!Number.isFinite(page)) return null;
  const ratio = Number.isFinite(here?.ratio) ? here.ratio : 0;
  return { offset: page, pdfPage: page, ratio, text: `Page ${page}`, at: Date.now() };
}

// Is `b` close enough to `a` that a reader standing at one can already see the
// other? Two anchors of different shapes are never the same spot, and a missing
// anchor is never near anything — an unknown position must prompt and must not
// suppress a write.
export function sameSpot(a, b) {
  if (!a || !b) return false;
  const aPage = Number(a.pdfPage);
  const bPage = Number(b.pdfPage);
  if (Number.isFinite(aPage) || Number.isFinite(bPage)) {
    if (!Number.isFinite(aPage) || !Number.isFinite(bPage)) return false;
    if (aPage !== bPage) return false;
    return Math.abs((Number(a.ratio) || 0) - (Number(b.ratio) || 0)) < BOOKMARK_NEAR_RATIO;
  }
  if (!Number.isFinite(a.offset) || !Number.isFinite(b.offset)) return false;
  return Math.abs(a.offset - b.offset) < BOOKMARK_PROMPT_NEAR_CHARS;
}

// Shows/hides the persistent "go to bookmark" button for whatever is open right
// now. Safe to call unconditionally on every notes render.
//
// It used to say which of two things the SET button would do as well. There is
// no SET button any more — the sync sets it — so this is down to the one fact
// it still has to tell: whether there is anywhere to go.
export function refreshBookmarkButtonUI() {
  if (el.bookmarkGoBtn) el.bookmarkGoBtn.hidden = !state.meta?.bookmark;
}

// ── The capture ────────────────────────────────────────────────────────────
//
// Called by reconcileAllDecks, at the top, BEFORE its sign-in/offline/in-flight
// guards. That placement is the whole point: those guards return early, and a
// reader who presses Sync on a train with the button gone would otherwise have
// no way to save their place at all. Writing it here puts it in state.meta
// regardless; scheduleDeckAutosave persists it, and whichever sync next
// succeeds carries it.
//
// No pushBookmarkNow. That fast lane exists to beat a deck push it is not part
// of; here the deck push is moments away and carrying this very value, so
// calling it would be a second write of the same thing.
export function captureBookmarkForSync({ announce = false } = {}) {
  if (resumeSettledForKey !== currentDeckKey()) return false;
  const next = currentSpotAnchor();
  if (!next) return false;
  // Standing still writes nothing — see BOOKMARK_PROMPT_NEAR_CHARS.
  if (sameSpot(state.meta?.bookmark, next)) return false;
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), bookmark: next };
  // This device just set it — it must never see a "jump to bookmark?" prompt
  // for its own bookmark.
  recordBookmarkPrompted(currentDeckKey(), next.at);
  refreshBookmarkButtonUI();
  // Rides the normal save path (see deckContentMatches in local-library.js,
  // which treats a changed meta.bookmark.at as real content), so this reaches
  // the cloud through the ordinary sync push.
  scheduleDeckAutosave();
  // A toast per auto-sync is noise; a toast for a sync the reader pressed is
  // the only thing that says the press did anything to their place in the book.
  if (announce) showToast("Saved where you are reading");
  return true;
}

export function goToBookmark() {
  const bookmark = state.meta?.bookmark;
  if (!bookmark) return;
  scheduleNoteJump(bookmark, { patient: true });
}

// Called once per deck-load, after the ambient same-device resume (if any) has
// settled — see the onSettled hook threaded through scheduleNoteJump in
// deck-snapshot.js / web-decks.js, and the `else` beside it for a deck that had
// no position to resume to. Never competes with that resume for the scroller:
// it only ever runs after it is done.
//
// Which is also what makes it the right place to arm captureBookmarkForSync.
// See resumeSettledForKey above.
export function maybePromptBookmarkJump() {
  resumeSettledForKey = currentDeckKey();
  // The other reliable per-deck moment. refreshBookmarkButtonUI's own call site
  // is the notes render (notes-view.js), which a PDF deck opening straight onto
  // its Document tab never reaches — so without this the way back to a bookmark
  // stayed hidden on exactly the surface that now has no other door to it.
  refreshBookmarkButtonUI();
  const bookmark = state.meta?.bookmark;
  if (!bookmark || !Number.isFinite(bookmark.offset)) return;
  const key = currentDeckKey();
  if (wasBookmarkPrompted(key, bookmark.at)) return;
  // Recorded as seen the moment the decision is made — whether that's because
  // the prompt is about to show, or because it turned out to be unnecessary.
  // Either way this exact bookmark version has now been accounted for on this
  // device, so it won't nag again until a newer one replaces it.
  recordBookmarkPrompted(key, bookmark.at);
  if (sameSpot(bookmark, currentSpotAnchor())) return;
  showConfirmModal(
    "You left off somewhere else in this deck on another device. Jump there?",
    () => scheduleNoteJump(bookmark, { patient: true }),
    { confirmLabel: "Jump to bookmark" }
  );
}
