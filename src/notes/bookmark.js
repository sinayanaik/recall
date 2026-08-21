// A deliberate, cross-device bookmark — the manual counterpart to the ambient,
// same-device-only reading position in reading-position.js/scroll-anchor.js.
//
// Set by an explicit button press, stored at meta.bookmark (same anchor shape
// as meta.readingPosition), pushed to the cloud immediately, and surfaced on
// another device two ways: a one-time "jump there?" prompt right after the
// ambient same-device resume settles, and a persistent "go to bookmark" button
// for whenever that prompt is missed or dismissed.

import { el } from "../core/dom.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { scheduleNoteJump } from "./anchors.js?v=__BUILD__";
import { recordBookmarkPrompted, wasBookmarkPrompted } from "./bookmark-prompt-store.js?v=__BUILD__";
import { currentDeckKey, rawOffsetForCurrentNotesScroll } from "./scroll-anchor.js?v=__BUILD__";
import { trimNoteAnchor } from "../quick-notes/anchors.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import { pushBookmarkNow } from "../sync/bookmark-cloud.js?v=__BUILD__";
import { setStatus, showConfirmModal, showToast } from "../ui/feedback.js?v=__BUILD__";

// Roughly the span of the text snippet an anchor already carries (trimNoteAnchor
// caps `text` at 300 chars) — "near" means the reader can already see the
// bookmarked text without scrolling, so a prompt on top of the silent ambient
// resume that already landed there would be pure noise.
export const BOOKMARK_PROMPT_NEAR_CHARS = 500;

function buildBookmarkAnchor(offset) {
  const notes = state.notes || "";
  const text = notes.slice(offset, offset + 80).trim() || notes.slice(Math.max(0, offset - 80), offset).trim();
  const trimmed = trimNoteAnchor({ offset, source: notes.slice(offset, offset + 80), text });
  if (!trimmed) return null;
  // trimNoteAnchor drops `.at` (quick-notes pins don't want one) — re-add it
  // after trimming. Without this the bookmark would carry no timestamp at
  // all, and both cross-device ordering (pushBookmarkNow) and the prompt
  // dedup (bookmark-prompt-store) compare on exactly this field.
  return { ...trimmed, at: Date.now() };
}

// Shows/hides the persistent "go to bookmark" button for whatever note is
// open right now, and says which of the two things the SET button will do.
// Safe to call unconditionally on every notes render.
//
// Pressing set a second time does not add a bookmark, it replaces the one you
// had — the note carries exactly one (meta.bookmark). Saying "Bookmark this
// spot" either way made that a thing you could only learn by losing a
// bookmark, so once there is one the button says "Move bookmark here" instead.
export function refreshBookmarkButtonUI() {
  const saved = Boolean(state.meta?.bookmark);
  if (el.bookmarkGoBtn) el.bookmarkGoBtn.hidden = !saved;
  const set = el.bookmarkSetBtn;
  if (!set) return;
  const label = set.querySelector(".nhm-label");
  if (label) label.textContent = saved ? "Move bookmark here" : "Bookmark this spot";
  set.title = saved
    ? "Move your bookmark to where you are now — a note keeps one"
    : "Bookmark this spot so you can come back to it on any device";
  set.setAttribute("aria-label", saved
    ? "Move your bookmark to this spot in the notes"
    : "Bookmark this spot in the notes");
}

export function bookmarkCurrentSpot() {
  if (!el.notesView || el.notesView.hidden || state.viewMode !== "notes") return;
  const offset = rawOffsetForCurrentNotesScroll();
  const bookmark = offset != null ? buildBookmarkAnchor(offset) : null;
  if (!bookmark) {
    setStatus("Couldn't find a spot to bookmark here.", "error");
    return;
  }
  state.meta = { ...(state.meta && typeof state.meta === "object" ? state.meta : {}), bookmark };
  // This device just set it — it must never see a "jump to bookmark?" prompt
  // for its own bookmark.
  recordBookmarkPrompted(currentDeckKey(), bookmark.at);
  refreshBookmarkButtonUI();
  // Rides the normal save path (see deckContentMatches in local-library.js,
  // which now treats a changed meta.bookmark.at as real content), so this
  // also reaches the cloud through the ordinary sync push. The call below is
  // just for getting it there promptly, without waiting on that.
  scheduleDeckAutosave();
  if (state.deckId) pushBookmarkNow(state.deckId, state.localDeckId, bookmark);
  showToast("Bookmarked this spot");
}

export function goToBookmark() {
  const bookmark = state.meta?.bookmark;
  if (!bookmark) return;
  scheduleNoteJump(bookmark, { patient: true });
}

// Called once per deck-load, after the ambient same-device resume (if any)
// has settled — see the onSettled hook threaded through scheduleNoteJump in
// deck-snapshot.js / web-decks.js. Never competes with that resume for the
// scroller: it only ever runs after it is done.
export function maybePromptBookmarkJump() {
  const bookmark = state.meta?.bookmark;
  if (!bookmark || !Number.isFinite(bookmark.offset)) return;
  const key = currentDeckKey();
  if (wasBookmarkPrompted(key, bookmark.at)) return;
  const nowOffset = rawOffsetForCurrentNotesScroll();
  const near = Number.isFinite(nowOffset) && Math.abs(nowOffset - bookmark.offset) < BOOKMARK_PROMPT_NEAR_CHARS;
  // Recorded as seen the moment the decision is made — whether that's because
  // the prompt is about to show, or because it turned out to be unnecessary.
  // Either way this exact bookmark version has now been accounted for on this
  // device, so it won't nag again until a newer one replaces it.
  recordBookmarkPrompted(key, bookmark.at);
  if (near) return;
  showConfirmModal(
    "You bookmarked a spot in this note on another device. Jump there?",
    () => scheduleNoteJump(bookmark, { patient: true }),
    { confirmLabel: "Jump to bookmark" }
  );
}
