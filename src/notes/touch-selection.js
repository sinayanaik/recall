// Selecting text with a FINGER, implemented by the app instead of the browser.
//
// ── Why this exists at all ─────────────────────────────────────────────────
//
// The previous attempt (commit 960ec1e) fixed five real bugs by getting OUT of
// the native gesture's way: touch-action back to `auto` on every reading
// surface, content-visibility suspended under a live selection, the paged snap
// held off, the pill's expensive capture deferred, the card swipe standing down
// for a dwelling finger. Every one of those was worth doing and all of them are
// still here. But the approach has a ceiling, and the report after that push is
// exactly the ceiling:
//
//   • "there is at least a 3-4s gap after I hard press and then only selection
//     starts". Android's long-press-to-select is MAIN-THREAD GATED. The
//     compositor hands the touch to the renderer and the press only becomes a
//     selection once the renderer acks it, so every long task in the app — a
//     chunk render, a reading-position pass, an IntersectionObserver batch — is
//     added to that delay. An app can make its own work smaller. It cannot make
//     that number deterministic, because it does not own the timer.
//
//   • "the start and end indicators for the text selection is entirely
//     incorrect". The native highlight and the two native handles are drawn
//     from a layout snapshot taken when the gesture began. Every
//     contain-intrinsic-size ESTIMATE that resolves to a real height during the
//     drag desyncs them from the text. Suspending containment narrows that
//     window; it cannot close it.
//
//   • "more error when I am starting selection from the very start of a
//     corner". caretPositionFromPoint at the left edge of a first line
//     hit-tests into the block's PADDING and resolves to the container element
//     rather than to a text node, so the anchor lands in a neighbouring block.
//
// So this module stops negotiating. On a touch screen the native selection
// gesture is suppressed outright (user-select: none, see
// styles/32-touch-select.css) and press → select → drag → act is implemented
// here: our own timer, our own hit-testing, our own handles, and the selection
// painted by the CSS Custom Highlight API — which is drawn by the same layout
// pass as the text and therefore CANNOT desync from it the way the screenshot
// shows.
//
// ── What made this affordable ──────────────────────────────────────────────
//
// Measured in headless Chrome before a line of this was written, because the
// answer decides the whole design: over `user-select: none` content,
// Selection.toString() returns "" — but Range.toString(), cloneContents(),
// intersectsNode(), getClientRects() and the selection's own anchorNode /
// focusNode / isCollapsed / rangeCount are all completely correct.
//
// Every reader in this app goes through getRangeAt(0) plus Range operations:
// activeRenderedTarget(), notesSelectionRange(), renderedSelectionStrings(),
// overlappingMarkIndex(), notesSelectionIsLive(). So the range we own is
// MIRRORED into the real Selection and the rest of the app carries on exactly
// as before, with one single exception — src/notes/mark-menu.js, which called
// Selection.toString() and now reads its range instead.
//
// ── Owning the gesture is not the same as it feeling steady ────────────────
//
// The report after the takeover landed: "it somehow worked but ... a unstable
// visual behaviour, all functionality works but it only feels a little
// unstable — also it is not persistent, like when I am selecting and scroll to
// select more it forgets the previous selections, also it feels a little
// flickering."
//
// Four separate causes, all of them ours and all of them in this file:
//
//   • The dismissal was decided on the TOUCHSTART — a touch outside the
//     selection cleared it. A scroll begins with exactly that touch, so
//     scrolling to reach the rest of the passage threw the selection away
//     before the finger had moved a pixel, and a near-miss on a handle did the
//     same. It is decided on the touchEND now, where a tap and a scroll can be
//     told apart. See onRootTouchStart / onRootTouchEnd.
//
//   • A handle whose boundary had scrolled off the surface was hidden, so past
//     one screenful there was nothing left to grab. It parks at the edge
//     instead, and dragging a parked grip brings that boundary to the finger.
//     See placeHandle.
//
//   • The handles are on a fixed overlay moved by JavaScript, while the
//     reading surface scrolls on the compositor — they cannot be in step, so
//     they swam behind the text on every fling. They fade out while the surface
//     is moving and are placed again once it settles. The painted selection is
//     not affected by any of this and never was: ::highlight() is laid out by
//     the same pass as the text. See onRootScroll.
//
//   • extendTo() ran straight off every touchmove — up to twice a frame on a
//     120Hz phone — with layout-forcing rect reads interleaved with the class
//     writes of the containment pass. That is layout thrash. The event records
//     the point; one rAF does the work and places the handles in the same pass.
//     See runFrame / scheduleFrame.
//
// ── Desktop never reaches any of this ──────────────────────────────────────
//
// Three independent fences, any one of which is enough on its own:
//
//   1. canTouchSelect() below — `(pointer: coarse) and (hover: none)` describes
//      the PRIMARY pointer, so a touchscreen laptop, whose primary pointer is a
//      cursor, reports `(pointer: fine) and (hover: hover)` and stays on the
//      native path despite having a digitiser.
//   2. Only touchstart / touchmove / touchend are ever bound. A mouse cannot
//      produce a touchstart, so even under devtools device emulation a mouse
//      drag cannot enter this code.
//   3. Every rule in styles/32-touch-select.css sits under
//      `body.has-touch-select`, and that class is added only by arm() below. A
//      stylesheet cannot switch selection off on a machine whose JavaScript
//      never took it over.

import { el } from "../core/dom.js?v=__BUILD__";
import { setTouchGestureHoldsSurface } from "../core/gesture.js?v=__BUILD__";
import { resetCardDrag } from "../cards/swipe.js?v=__BUILD__";
import { NOTES_BLOCK_SELECTOR, caretFromPoint } from "./raw-offset.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS, isTopLevelBlockParent } from "../render/block-cache.js?v=__BUILD__";
// A hoisted `function` declaration, read only inside a call — the same discipline
// every other crossing binding in this neighbourhood follows.
import { isProgrammaticNotesScroll, markProgrammaticNotesScroll } from "./notes-view.js?v=__BUILD__";
import {
  clearSelectionStableRegion,
  hideNotesSelectionButton,
  markSelectionStableRegion,
  positionNotesSelectionButton,
  setTouchSelectionArmed,
  setTouchSelectionDragging,
} from "./selection.js?v=__BUILD__";

// The name the highlight is registered under with CSS.highlights, and the same
// name styles/32-touch-select.css paints with ::highlight().
export const HIGHLIGHT_NAME = "recall-touch-selection";

// How long a finger has to rest before it is a press rather than a scroll.
// 240ms, against Android's own ~500ms, deliberately: the whole complaint is
// that selection takes too long to arrive, and we are not paying a main-thread
// round trip on top of it. This is under the ~250ms where a slow scroll start
// begins to register as a press, which used to be the floor — what buys the
// extra 80ms is the escape below, which takes the gesture back when a press
// that fired this early turns out to have been the start of a scroll.
export const LONG_PRESS_MS = 240;

// How far the finger may wander in that time and still be pressing. A real
// touch slop — a thumb resting on glass moves several pixels — and the same
// value swipe.js settled on for its own dwell test (dwellSlopPx).
export const PRESS_SLOP_PX = 10;

// The escape. For this long after a press fires, a finger that leaves in a
// hurry is a scroll that we called too early, not a reader extending their
// selection: the word is unselected again and the gesture is let go. Past the
// window a fast slide is just a fast slide and the selection stands.
//
// The window has to outlast the gap between the press firing and the reader's
// finger reacting to it (~a frame or two), and stay well inside the time a
// deliberate press-and-slide spends on its first word.
export const PRESS_ESCAPE_MS = 120;

// ── ...measured from where the press FIRED, on the move's OWN clock ────────
//
// Reported as "it vibrates but doesn't start selecting any content", and as "it
// initially selects something but as soon as I try to select more content it
// starts to scroll". The second is this escape described exactly — the
// selection is dropped and beginEscapeScroll takes over the surface — and the
// first is the same event seen a moment earlier. The buzz below only fires
// AFTER setSelectionPoints has succeeded, so a buzz with nothing selected means
// a selection was made and taken away again, and this was taking it.
//
// Three things were wrong with the test, and each one on its own is enough:
//
//   • The distance was measured from pressOrigin — where the finger TOUCHED
//     DOWN — but the press fires at pressX/pressY, which deliberately follow a
//     rolling thumb through PRESS_SLOP_PX (see onRootTouchMove). A press that
//     fired 9px from its origin had 9px of budget left, not 18. It is measured
//     from pressFiredX/pressFiredY now, which is the point the reader actually
//     watched a word light up under.
//
//   • The window was `performance.now()` read inside the HANDLER, not the
//     move's own timestamp. A touchmove generated 20ms after the press but
//     delivered 150ms later — because the renderer was busy, which on a note
//     built as it is read is a span being lexed — arrived carrying every pixel
//     the finger had travelled in between, and still measured as "inside
//     120ms". Main-thread jank did not merely coincide with the bug; it
//     MANUFACTURED it, on exactly the notes where it was reported. A trusted
//     touch event's timeStamp is on the same clock as performance.now(), so
//     using it costs nothing and asks the real question: how fast was the
//     finger moving WHEN it moved.
//
//   • There was no speed test at all, which is what "leaves in a hurry" means.
//     18px in 120ms is 150px/s — a slow, deliberate slide, and the single most
//     ordinary way to extend a selection you have just made.
//
// So the escape now needs both: past the distance AND above the speed. A flick
// still hands the gesture back; a reader sliding onto the next few words keeps
// what they pressed for.
export const PRESS_ESCAPE_PX = 18;

// 0.5px/ms is 500px/s. A flick that the reader means as a scroll crosses a
// phone screen in a few hundred milliseconds — well over 1000px/s — and a
// deliberate press-and-slide, measured on a real note, sits under 200px/s. The
// gap between the two is wide enough that this number does not have to be
// exact, which is the point of choosing a quantity that HAS a gap.
export const PRESS_ESCAPE_SPEED_PX_PER_MS = 0.5;

// A handle is grabbed by its bulb, which hangs BELOW the line it marks, so the
// caret being chosen sits above the finger. The real offset is MEASURED at the
// moment of the grab — see grabOffsetY — because it depends on the line's height
// and on where in the bulb the thumb actually landed, and a constant that is
// wrong by half a line puts the caret on the wrong row. This is only the
// fallback for a grab whose boundary rect could not be read.
export const HANDLE_GRAB_OFFSET_PX = 34;

// How close to the edge of the reading surface a drag has to get before the
// view starts scrolling itself, and how fast it does so at the very edge.
export const EDGE_PX = 64;
export const EDGE_MAX_SPEED_PX = 16;

// ...and how long the finger has to STAY there first.
//
// The band was armed by the first touchmove of a drag, with no test of intent.
// On a phone #notesView is very nearly the whole screen, so the lower 64px of
// it is where a thumb goes to extend a selection downward — and a press that
// fires inside the band starts a 960px/s auto-scroll on the very first move.
// The reader reads that as "as soon as I try to select more content it starts
// to scroll", and they are not wrong: the page IS being scrolled, by us, before
// they have asked for anything.
//
// A dwell separates the two gestures without removing either. Holding a
// boundary at the edge to run past the screen is a thing readers do
// deliberately and hold still for; brushing the band on the way to a word is
// over in a frame or two. 120ms is comfortably longer than the second and
// shorter than the first — and it is the same number SCROLL_SETTLE_MS uses for
// the same kind of "has this stopped moving" question.
export const EDGE_ARM_MS = 120;

// How long after the last scroll event the handles are placed again and faded
// back in. They are drawn on a fixed overlay and moved by JavaScript, while the
// reading surface scrolls on the compositor — so during a fling they can only
// ever trail the words they mark. Hiding them for the duration and restoring
// them once the view is still is the difference between a grip that swims and
// one that is simply not there yet. The painted selection is unaffected: the
// Custom Highlight API lays it out in the same pass as the text.
export const SCROLL_SETTLE_MS = 120;

// ── How long a finished selection is defended from a stray collapse ────────
//
// The document selection going collapsed normally means the reader dismissed
// it, and the listener in initTouchSelection answers that by dropping ours too.
// Two things collapse it that the reader did not ask for, and both land within
// a few frames of a gesture ending:
//
//   • The compatibility mousedown after a touchend. onRootTouchEnd cancels the
//     touchend to stop it — but a touchend is only cancellable if the browser
//     has not already taken the sequence (see gestureStolen), and when it has,
//     that preventDefault is a no-op. Chrome then places a caret where the
//     finger lifted and the selection is gone: a buzz, a flash of highlight,
//     nothing. Exactly the reported "it vibrates but doesn't start selecting
//     any content", arriving about 50ms after the buzz.
//
//   • Anything that places a caret in the reading surface while a gesture is
//     still resolving — the same default, arriving from a tap the controller
//     did not get to cancel.
//
// Inside this window a caret placed over a live selection is answered by
// re-mirroring our own Range instead, which is legitimate precisely because the
// Range is the source of truth in this module and the mirror is a copy of it.
//
// The window is the SECOND of the two tests, not the first. What actually tells
// a stray collapse from a real dismissal is that a dismissal calls
// removeAllRanges() and leaves no range at all, where this leaves a caret — see
// defendSelection. The clock only bounds how long that repair is on offer, so a
// caret placed a second later (a reader tapping to dismiss, which also collapses
// through this path on some builds) is obeyed like any other.
export const SELECTION_DEFEND_MS = 350;

// ── The gate ───────────────────────────────────────────────────────────────

export const touchSelectMedia = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(pointer: coarse) and (hover: none)")
  : null;

export function canTouchSelect() {
  if (!touchSelectMedia?.matches) return false;
  if (!(navigator.maxTouchPoints > 0)) return false;
  // The takeover is only safe if we can paint what we took over. Without the
  // Custom Highlight API a selection would be invisible, which is worse than
  // the bug being fixed — so an older browser keeps the native gesture and
  // everything styles/31-touch-selection.css does for it.
  return Boolean(window.CSS && window.CSS.highlights && typeof window.Highlight === "function");
}

// ── State ──────────────────────────────────────────────────────────────────
//
// One Range is the source of truth, and it is the SAME object handed to the
// Highlight — Ranges are live, so mutating it repaints the selection with no
// per-frame paint work of our own. The two boundaries are tracked separately
// because a drag that crosses its own start has to swap them, exactly as the
// native handles do.

let armed = false;
let overlay = null;
let handleStart = null;
let handleEnd = null;
let touchHighlight = null;

let liveRoot = null;
let liveRange = null;
let anchorPoint = null; // { node, offset } — the end that stays put
let focusPoint = null;  // { node, offset } — the end being dragged

let pressTimer = null;
let pressX = 0;
let pressY = 0;
let pressActive = false;   // a finger is down and might still become a press
let pressDragging = false; // the press fired and that same finger is extending
// When the press fired, so the escape window can be measured from it. Only read
// while pressDragging — a handle drag never sets it.
let pressFiredAt = 0;
// ...and WHERE it fired, which is not where the finger landed: pressX/pressY
// follow a rolling thumb through the slop, so the press can resolve up to
// PRESS_SLOP_PX away from pressOrigin. The escape is measured from here — see
// PRESS_ESCAPE_PX.
let pressFiredX = 0;
let pressFiredY = 0;
// The previous touchmove of this gesture, on the move's own clock, so the escape
// can ask how fast the finger is travelling rather than only how far it has got.
// Reset on every touchstart; NaN means "no previous move to compare against",
// which is the first move of a gesture and never an escape on its own.
let lastMoveX = NaN;
let lastMoveY = NaN;
let lastMoveAt = NaN;
// ── Has the browser taken this gesture already? ────────────────────────────
//
// .notes-rendered is `touch-action: auto` on a coarse pointer
// (styles/31-touch-selection.css) and nothing preventDefaults during the 240ms
// press window, so Chrome is free to start scrolling the moment its own touch
// slop is crossed — which sits right on top of PRESS_SLOP_PX. From that instant
// every touchmove in the sequence arrives with `cancelable === false`, and:
//
//   • the preventDefault in the press-drag branch is a no-op, so the page
//     scrolls out from under a selection the reader is still making;
//   • the preventDefault in onRootTouchEnd is a no-op too, so the
//     compatibility mousedown fires and Chrome COLLAPSES the selection — buzz,
//     a flash of highlight, then nothing.
//
// `body.is-touch-dragging { touch-action: none }` cannot rescue either one.
// touch-action is latched when a touch sequence begins; a class added at
// beginDrag() governs the NEXT touch, not this one. See styles/32-touch-select.css.
//
// So the flag is read rather than guessed at. `cancelable` is the browser
// stating, per event, whether we still own the gesture — exact, free, and true
// on every device without a slop constant that has to match Chrome's.
let gestureStolen = false;
// { root, x, y } while an escaped gesture is being scrolled by us instead of by
// the browser, null the rest of the time. See beginEscapeScroll.
let escapeScroll = null;
// Where the finger first landed, and where the surface was scrolled to at that
// moment. The slop test is measured against the ORIGIN while pressX/pressY
// follow the finger, so a press that fires after a few pixels of thumb drift
// hit-tests where the finger actually is rather than where it started.
let pressOriginX = 0;
let pressOriginY = 0;
let pressRoot = null;
let pressScrollTop = 0;
let pressScrollLeft = 0;
// The block that was under the finger when it landed, and where it was on the
// GLASS at that moment. This is what "has the page moved" is measured against —
// see scrollDrift.
let pressAnchor = null;
let pressAnchorTop = 0;
let pressAnchorLeft = 0;
// The per-frame sampler that keeps those two current, and everything the page
// has drifted since touchdown that the sampler has already absorbed. See
// PRESS_SETTLE_MAX_PX.
let pressDriftFrame = 0;
let pressDriftTotal = 0;
// A touch that landed outside the current selection MIGHT be a dismissal — but
// only if it turns out to be a tap. Deciding at touchstart is what threw a
// selection away the instant a reader put a finger down to scroll, which is the
// "it forgets the previous selection" half of the report.
let dismissPending = false;

let draggingHandle = "";   // "" | "start" | "end"
// How far the finger is below the caret it is choosing, measured at the grab.
// Zero for a press-drag, where the finger IS the caret.
let grabOffsetY = 0;
let edgeFrame = 0;
let edgeVector = 0;
let edgePoint = null;
// When the finger first entered the edge band on this pass, and the timer that
// arms the band once it has been there EDGE_ARM_MS. Both cleared the moment it
// leaves — see updateEdgeScroll.
let edgeEnteredAt = NaN;
let edgeArmTimer = 0;

// ── One pass per frame ─────────────────────────────────────────────────────
//
// A touchmove arrives up to twice a frame on a 120Hz phone, and extendTo() is
// not cheap: a hit-test, a binary search whose every step forces layout to read
// a caret rect, and a containment pass that writes classes. Running it straight
// off the event interleaved those reads with those writes — read, write, read —
// which is layout thrash, and it is what made a drag feel like it was
// stuttering rather than tracking.
//
// So the event only records WHERE the finger is. One rAF does the work, at most
// once per frame, and places the handles in the same pass — the handle update
// used to schedule a second frame of its own.
let framePoint = null;      // the finger, viewport coords, latest value wins
let frameHandle = 0;
let frameWantsExtend = false;
let lastExtendX = NaN;
let lastExtendY = NaN;

// The Range currently registered with the Highlight. The registration survives
// every mutation of that Range — it is live, and the highlight is repainted from
// it — so clear()+add() belongs to a NEW range and not to every drag frame.
let paintedRange = null;

// Until when a collapsed document selection is repaired rather than obeyed.
// Zero means "not defending" — see SELECTION_DEFEND_MS.
let selectionDefendedUntil = 0;
// When the last repair ran. One per frame at most: mirrorToSelection() fires
// selectionchange itself, so a repair answered by another repair would spin,
// and a collapse that survives one repair is not one more repairs will fix.
//
// A timestamp rather than a flag cleared on the next animation frame, because
// rAF does not run in a background tab — a flag set just before the reader
// switched away would stay set, and the defence would be quietly off for the
// rest of the session.
let defendedAt = 0;

// One frame at 60Hz. The number only has to be long enough to cover the
// selectionchange our own mirror is about to fire, which is delivered on the
// same task queue a moment later.
export const SELECTION_DEFEND_GAP_MS = 16;

let scrollSettleTimer = 0;

export function touchSelectionRoots() {
  return [el.notesView, el.questionView, el.answerView, el.documentView].filter(Boolean);
}

// ── One controller, two shapes of surface ──────────────────────────────────
//
// Everything above this line is about markdown: a "block" is a <p> or an <li>,
// the chunk wrappers of a long note are stepped through, and a caret that lands
// in the margin between two paragraphs is repaired against the pair either side
// of it. None of that is a fact about SELECTION — it is a fact about the notes
// view — and the Document surface is the same gesture over a different tree:
//
//   #documentView > .pdf-pages > .pdf-page > .pdf-text-layer > span[data-item-index]
//
// where a "block" is one text item's span and the thing that owns a run of them
// is the page's text layer.
//
// The header of this file explains at length why the native gesture had to be
// taken over on a touch screen: a main-thread-gated 3-4 second press, handles
// drawn from a stale layout snapshot, a hit-test that resolves into padding at
// the edge of a block. Every one of those is WORSE over a PDF, not better — the
// text layer is hundreds of absolutely-positioned transparent spans over a
// canvas, and a page rendering mid-gesture is exactly the layout change that
// desyncs a native handle. So the surface is bound like any other, and the two
// places that were quietly notes-specific ask which root they are on.
export const PDF_TEXT_LAYER_CLASS = "pdf-text-layer";

export const PDF_TEXT_ITEM_SELECTOR = "[data-item-index]";

function isDocumentSelectionRoot(root) {
  return Boolean(root) && root === el.documentView;
}

// The selector for "the smallest thing a caret repair should search inside".
function rootBlockSelector(root) {
  return isDocumentSelectionRoot(root) ? PDF_TEXT_ITEM_SELECTOR : NOTES_BLOCK_SELECTOR;
}

// Is `node` the container a top-level block of this surface sits directly in?
//
// On the document surface this is deliberately the TEXT LAYER and not
// #documentView: left to isTopLevelBlockParent, topLevelBlockFor would walk all
// the way up to .pdf-pages — whose parent IS the root — and hand the gap-repair
// search the entire document's text nodes to sweep, per drag frame.
function isRootBlockParent(node, root) {
  if (isDocumentSelectionRoot(root)) return Boolean(node?.classList?.contains(PDF_TEXT_LAYER_CLASS));
  return isTopLevelBlockParent(node, root);
}

// The range the reader currently has selected with a finger, or null. Exported
// for the pill's Copy / Share / Web search buttons, which want the text and not
// the markdown serialisation the other buttons work from.
export function touchSelectionRange() {
  if (!rangeStillLive()) return null;
  return liveRange.collapsed ? null : liveRange;
}

// A note re-renders by replacing its blocks, and a range whose nodes have been
// detached still answers questions — with nonsense. Chrome does fire
// selectionchange when a mutation destroys the selection, and the listener in
// initTouchSelection cleans up on it; this is the belt to that braces, checked
// wherever the range is about to be trusted. Two `contains` calls, so it is
// affordable on a drag frame.
function rangeStillLive() {
  if (!liveRange || !liveRoot) return false;
  if (!liveRoot.isConnected) return false;
  if (!liveRoot.contains(liveRange.startContainer) || !liveRoot.contains(liveRange.endContainer)) return false;
  return true;
}

export function touchSelectionIsDragging() {
  return Boolean(draggingHandle || pressDragging);
}

// ── Hit-testing that survives the edges of a block ─────────────────────────
//
// caretFromPoint() (src/notes/raw-offset.js) wraps the two spellings of the
// platform API. It is correct in the middle of a paragraph and unreliable
// everywhere else, and "everywhere else" is where readers actually aim: the
// gutter left of the first character, the space above the first line, the
// margin between two blocks. In all of those it resolves to the CONTAINING
// ELEMENT rather than to a text node, and an element boundary used as a
// selection anchor lands on whichever child index the browser picked — a
// neighbouring block, usually.
//
// This is the "especially when starting from the very start of a corner" bug.

function usableCaret(pos, root) {
  return Boolean(pos && pos.node && pos.node.nodeType === Node.TEXT_NODE && root.contains(pos.node));
}

// The reading surface's own content box — inside its padding, which on the
// notes view is substantial (styles/12-notes.css gives it --notes-padding plus
// the stage bleed) and is exactly the strip a caret hit-test falls through.
function contentBox(root) {
  const rect = root.getBoundingClientRect();
  const cs = getComputedStyle(root);
  return {
    left: rect.left + parseFloat(cs.paddingLeft || 0) + 1,
    right: rect.right - parseFloat(cs.paddingRight || 0) - 1,
    top: rect.top + 1,
    bottom: rect.bottom - 1,
  };
}

// The deepest element at a point, probing a few nearby rows first. The probes
// are what cover the vertical GAPS — a point in the margin between two
// paragraphs belongs to neither, and elementFromPoint answers with the scroller
// itself, which is useless as an anchor.
// A CHUNK is not an answer. On a note past NOTES_CHUNK_MIN_BLOCKS the reading
// surface's children are wrappers of forty blocks (src/render/block-cache.js),
// and a probe that lands in the margin between two of them resolves to the
// wrapper. Handing that to closestCaretIn means walking up to 400 text nodes and
// taking a rect off each — per drag frame, on a note where forty blocks is a lot
// of text. The nearest block INSIDE it is both the cheaper answer and the one the
// reader meant; picking it by vertical distance is the same rule closestCaretIn
// uses one level down.
function nearestChildTo(host, y) {
  let best = null;
  let bestDistance = Infinity;
  for (const child of host.children) {
    const rect = child.getBoundingClientRect();
    if (!rect.height && !rect.width) continue;
    const distance = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = child;
    }
  }
  return best;
}

function narrowToBlock(hit, y, root) {
  // The document surface's own version of the same rule. A probe that misses a
  // glyph box lands on the text layer, on the page, or on the box the pages sit
  // in — none of which is an anchor, and the last of which is the whole
  // document. The nearest SPAN inside whichever of those it was is both the
  // cheaper answer and the one the reader meant.
  if (isDocumentSelectionRoot(root)) {
    if (hit?.matches?.(PDF_TEXT_ITEM_SELECTOR)) return hit;
    const layer = hit?.classList?.contains(PDF_TEXT_LAYER_CLASS)
      ? hit
      : hit?.querySelector?.(`.${PDF_TEXT_LAYER_CLASS}`)
        || nearestChildTo(hit, y)?.querySelector?.(`.${PDF_TEXT_LAYER_CLASS}`);
    if (!layer) return hit;
    return nearestChildTo(layer, y) || layer;
  }
  if (!hit?.classList?.contains(NOTES_CHUNK_CLASS)) return hit;
  return nearestChildTo(hit, y) || hit;
}

function elementNear(x, y, root) {
  for (const dy of [0, -6, 6, -16, 16, -28, 28]) {
    const hit = document.elementFromPoint(x, y + dy);
    if (!hit || !root.contains(hit) || hit === root) continue;
    return narrowToBlock(hit, y, root);
  }
  return null;
}

// Is this caret position before the point, in reading order? Used as the
// comparator of the binary search below, so it has to be a total order over the
// offsets of one text node — which it is, because a text node's caret
// rectangles run left to right within a line and top to bottom between lines.
function caretIsBefore(rect, x, y) {
  if (rect.bottom <= y) return true;   // the caret's line is entirely above
  if (rect.top >= y) return false;     // ...entirely below
  return rect.left <= x;               // same line: compare horizontally
}

function boundaryRectIn(node, offset) {
  const probe = document.createRange();
  probe.setStart(node, offset);
  probe.setEnd(node, offset);
  return probe.getBoundingClientRect();
}

// The offset in `node` closest to (x, y), by binary search over its length.
// Eleven rect measurements for a 2,000-character node instead of 2,000 — which
// matters because this runs on every frame of a handle drag.
function offsetNear(node, x, y) {
  const length = node.nodeValue ? node.nodeValue.length : 0;
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (caretIsBefore(boundaryRectIn(node, mid), x, y)) lo = mid + 1;
    else hi = mid;
  }
  lo = Math.min(Math.max(lo, 0), length);
  // ── Round to the NEAREST caret, not up to the next one ───────────────────
  //
  // The search answers "the first offset that is not before the point", which is
  // up to one character past the nearest one. The platform's own hit-test rounds
  // to the nearest, so the two disagreed by a character — and since a repaired
  // frame goes through here while an ordinary frame goes through the platform,
  // that disagreement showed up as the boundary stepping back and forth by one
  // character between consecutive frames of a steady drag. Measured in
  // tools/touch-selection-check.mjs: nine reversals over a 23-step sweep.
  //
  // Only when both carets are on the same line: "nearer horizontally" means
  // nothing across a wrap, and the line was already chosen before the search ran.
  if (lo > 0) {
    const here = boundaryRectIn(node, lo);
    const prev = boundaryRectIn(node, lo - 1);
    if (Math.abs(here.top - prev.top) < 1 && Math.abs(prev.left - x) < Math.abs(here.left - x)) lo -= 1;
  }
  return lo;
}

// Every text node under `host`, in document order, skipping the furniture that
// styles/14-selection.css already declares is not text (the code block's
// language badge, an image's size badge and resize grip) plus anything with no
// rendered box at all.
function textNodesIn(host, limit = 400) {
  const out = [];
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.length) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".code-lang-badge, .notes-img-size-badge, .notes-img-resize-handle")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode() && out.length < limit) out.push(walker.currentNode);
  return out;
}

function closestCaretIn(host, x, y) {
  const nodes = textNodesIn(host);
  if (!nodes.length) return null;
  let best = null;
  let bestDistance = Infinity;
  const probe = document.createRange();
  nodes.forEach((node) => {
    probe.selectNodeContents(node);
    const rect = probe.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    // Vertical distance dominates: a reader aiming at a line wants THAT line,
    // even when their finger is well left or right of the words on it.
    const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
    const dx = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0);
    const distance = dy * 4 + dx;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  });
  if (!best) return null;
  return { node: best, offset: offsetNear(best, x, y) };
}

// ── Line FRAGMENTS, which tile where caret rects do not ────────────────────
//
// getClientRects() on a text node gives one rect per line fragment, and those
// are LINE-BOX height — so they tile vertically with no gap between them.
// boundaryRectIn's caret rects are TEXT height and do not: at any line-height
// above 1 there is a band between one line's carets and the next line's that
// belongs to neither, and a point in that band cannot be placed by comparing
// caret rects at all. Everything below resolves the line first, from fragments,
// and only then the offset within it.
function lineRectsIn(node, probe) {
  probe.selectNodeContents(node);
  // A whitespace run that collapsed at a line end has no box; a blank line
  // inside a <pre> has height and no width and is a real caret position, so the
  // test is "either", not "both".
  return Array.from(probe.getClientRects()).filter((rect) => rect.width || rect.height);
}

// How far either side of the point a text node has to reach before its
// fragments are worth measuring. Three lines is more than any gap this is
// called for, and it keeps a long list or a code block from costing one
// getClientRects() per node.
export const LINE_SEARCH_REACH_PX = 120;

// The caret in `block` nearest (x, y), by line rather than by caret.
//
// The point is placed on the nearest FRAGMENT, x is clamped into that fragment,
// and the binary search then runs at the fragment's vertical centre — where
// every caret rect on that line straddles the probe, so caretIsBefore reduces to
// its horizontal test and is monotonic. That is what stops a point in a gap
// resolving to column 0 of the line below it.
function caretOnNearestLine(block, x, y, root) {
  if (!block || block.nodeType !== Node.ELEMENT_NODE || !root.contains(block)) return null;
  const probe = document.createRange();
  let best = null;
  for (const node of textNodesIn(block, 64)) {
    probe.selectNodeContents(node);
    const union = probe.getBoundingClientRect();
    if (!union.height && !union.width) continue;
    // Cheap reject on one rect before paying for the per-line ones.
    if (y < union.top - LINE_SEARCH_REACH_PX || y > union.bottom + LINE_SEARCH_REACH_PX) continue;
    for (const rect of lineRectsIn(node, probe)) {
      const dy = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
      if (best && dy >= best.dy) continue;
      best = { dy, node, rect };
    }
  }
  if (!best) return null;
  const px = Math.min(Math.max(x, best.rect.left), best.rect.right);
  const py = best.rect.top + best.rect.height / 2;
  return { node: best.node, offset: offsetNear(best.node, px, py), dy: best.dy };
}

// The top-level block a node belongs to — a direct child of the reading surface,
// or of one of its chunk wrappers. For a list item that is the <ul>, which is
// exactly what the gap between two items wants: both lines belong to the same
// top-level block, so one search covers them.
function topLevelBlockFor(node, root) {
  // `up`, not `el`: this module imports `el` (the DOM handle registry).
  let up = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (up && up !== root && !isRootBlockParent(up.parentNode, root)) up = up.parentElement;
  return up && up !== root && isRootBlockParent(up.parentNode, root) ? up : null;
}

// The block before `block` in reading order, stepping out of a chunk wrapper
// when it is that wrapper's first child.
function previousTopLevelBlock(block, root) {
  const before = block.previousElementSibling;
  if (before) return before;
  // The first span of a page's text layer has no previous sibling and no chunk
  // to step out of; the page before it is a different page, which the gap
  // repair has no business reaching into.
  if (isDocumentSelectionRoot(root)) return null;
  const chunk = block.parentElement;
  if (!chunk || chunk === root || !chunk.classList?.contains(NOTES_CHUNK_CLASS)) return null;
  return chunk.previousElementSibling?.lastElementChild || null;
}

// How far outside its own caret rect the point may sit and still count as being
// ON that caret. A caret rect is text height and a line box is taller, so the
// point can legitimately be a little above or below; 0.6 covers an ordinary
// line-height with room to spare.
export const CARET_LINE_SLACK_RATIO = 0.6;

// ...and how far the caret may sit from the finger's COLUMN while it is in that
// band. A couple of characters: enough that an ordinary hit in the leading is
// never second-guessed, far less than the width of a line.
export const CARET_COLUMN_SLACK_PX = 24;

// ── Is the browser's answer actually under the finger? ─────────────────────
//
// Measured in Chromium 141, against a `user-select: none` reading surface:
// caretPositionFromPoint is line-correct everywhere INSIDE a block — mid-word,
// past the end of a short line, in the leading between two wrapped lines, left
// of the column, above the first line. In the MARGIN BETWEEN TWO BLOCKS it is
// not: it answers with offset 0 of the FOLLOWING block, regardless of x.
//
//   margin between two paragraphs, x = 150   ->  TEXT of #p2 @0
//   margin between two paragraphs, x = 280   ->  TEXT of #p2 @0
//   the gap between two <li> items           ->  TEXT of #l2 @0
//   a blockquote's left border strip         ->  TEXT of #bq @0
//
// That is a text node inside the view, so usableCaret accepts it and this
// function used to return it on the first probe — the repair ladder below never
// ran and nothing knew anything had gone wrong. A drag sweeps through those
// margins constantly, so the endpoint flew to the start of the next block and
// back as the finger crossed the gap: "selecting content inter line is not
// reliable ... it jumps to the start of a line", and a tint that flickers.
// Reproduced in tools/touch-selection-check.mjs: 14 of 20 samples across a 15px
// paragraph margin landed on offset 0.
//
// So the answer is checked rather than trusted. It is cheap — one collapsed
// rect — and it only ever rejects an answer that is a whole gap away from the
// finger.
function caretIsUnderPoint(caret, x, y) {
  const rect = boundaryRectIn(caret.node, caret.offset);
  if (!rect || !rect.height) return true; // nothing to judge it by
  // Squarely on the line's own text: nothing to doubt.
  if (y >= rect.top && y <= rect.bottom) return true;
  const slack = rect.height * CARET_LINE_SLACK_RATIO;
  // A whole gap away. Whatever this is, it is not under the finger.
  if (y < rect.top - slack || y > rect.bottom + slack) return false;
  // In between — the leading above or below a real line, where a genuine hit
  // does land. Told apart from a margin snap by the OTHER axis: the snap comes
  // back at offset 0, hard against the left edge of its block, while the finger
  // is somewhere along the line. A genuine hit is under the finger in both axes.
  return Math.abs(rect.left - x) <= CARET_COLUMN_SLACK_PX;
}

// The point is in the gap between two blocks. Resolve it against the LAST line
// of the one above and the FIRST line of the one below, and take whichever line
// the finger is actually nearer — which is what the reader means, and what the
// browser's own answer ignores.
function caretAcrossBlockGap(direct, x, y, root) {
  const below = topLevelBlockFor(direct.node, root);
  if (!below) return null;
  const above = previousTopLevelBlock(below, root);
  const under = caretOnNearestLine(below, x, y, root);
  const over = caretOnNearestLine(above, x, y, root);
  if (over && under) return over.dy <= under.dy ? over : under;
  return over || under;
}

// The repaired hit-test. Tried in order of how much it costs.
export function caretInRoot(x, y, root) {
  if (!root) return null;
  const box = contentBox(root);
  const cy = Math.min(Math.max(y, box.top), box.bottom);

  const cx = Math.min(Math.max(x, box.left), box.right);

  const direct = caretFromPoint(x, cy);
  if (usableCaret(direct, root)) {
    // Trusted only when it is actually under the finger — see caretIsUnderPoint.
    if (caretIsUnderPoint(direct, x, cy)) return direct;
    const nearer = caretAcrossBlockGap(direct, cx, cy, root);
    if (nearer) return nearer;
    return direct; // nothing better to offer; the old answer beats no answer
  }

  // 1. Probes NEAR THE FINGER, nearest first, alternating sides. A hit-test that
  //    missed at one pixel — an inline boundary, a sub-pixel position between two
  //    glyphs, the edge of an element — almost always succeeds a few pixels
  //    either side, and that answer is the caret the reader was aiming at.
  //
  //    Deliberately NOT the edges of the content box, which is what this used to
  //    try. At this app's default reading width a block fills the content box, so
  //    box.left lands inside the first character of the line and comes back as a
  //    perfectly usable caret — a confidently wrong answer, which is worse than
  //    no answer, because no answer falls through to the block-scoped search
  //    below. The clamp into the box is kept: that is the half of the old step 1
  //    that fixes the left-gutter case, and its own comment said so.
  const seen = new Set();
  for (const dx of [0, 4, -4, 10, -10, 20, -20]) {
    const tryX = Math.min(Math.max(cx + dx, box.left), box.right);
    if (seen.has(tryX)) continue;
    seen.add(tryX);
    const repaired = caretFromPoint(tryX, cy);
    if (!usableCaret(repaired, root)) continue;
    // The probe found the NODE; the offset it came back with is the one at the
    // nudged x, not at the finger. Re-resolve on the line it landed on, so a
    // repaired frame answers the same question as an unrepaired one — otherwise
    // the boundary steps sideways by however far the nudge reached, which on a
    // drag reads as the endpoint stuttering.
    const refined = caretOnNearestLine(topLevelBlockFor(repaired.node, root), cx, cy, root);
    if (refined) return refined;
    if (repaired.node.nodeType === Node.TEXT_NODE) {
      return { node: repaired.node, offset: offsetNear(repaired.node, cx, cy) };
    }
    return repaired;
  }

  // 2. Still an element — the point is in a margin, or on an atomic block. Find
  //    the block it belongs to and take the closest caret inside it.
  const elementHost = (direct && direct.node && direct.node.nodeType === Node.ELEMENT_NODE && root.contains(direct.node))
    ? narrowToBlock(direct.node, cy, root)
    : elementNear(cx, cy, root);
  if (elementHost) {
    const inside = closestCaretIn(elementHost, x, cy);
    if (inside) return inside;
  }
  return null;
}

// ── Word snapping ──────────────────────────────────────────────────────────
//
// A press selects a WORD, like every other platform. Intl.Segmenter rather than
// a regex because this app renders notes in whatever language they were written
// in, and a regex word boundary is an English assumption.

const wordSegmenter = (() => {
  try {
    return new Intl.Segmenter(navigator.language || "en", { granularity: "word" });
  } catch (_) {
    return null;
  }
})();

const WORD_RE = /[\p{L}\p{N}_'’-]+/gu;

function wordBoundsAt(text, offset) {
  if (!text) return null;
  if (wordSegmenter) {
    let fallback = null;
    for (const segment of wordSegmenter.segment(text)) {
      const start = segment.index;
      const end = start + segment.segment.length;
      if (offset < start) break;
      if (offset > end) continue;
      if (segment.isWordLike) return { start, end };
      // A press that lands on the space between two words: remember it, but
      // keep looking — the word STARTING at this offset is the better answer.
      if (!fallback && offset > start && offset < end) fallback = { start, end };
    }
    if (fallback) return fallback;
  }
  WORD_RE.lastIndex = 0;
  let match = WORD_RE.exec(text);
  let previous = null;
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset >= start && offset <= end) return { start, end };
    if (end < offset) previous = { start, end };
    if (start > offset) break;
    match = WORD_RE.exec(text);
  }
  return previous;
}

// The image, equation or diagram a press landed on, when there is no text to
// snap to. Selecting one is meaningful in this app — rangeHasImage() in
// selection.js exists precisely so the pill offers itself for a picture.
function atomicAt(x, y, root) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || !root.contains(hit)) return null;
  return hit.closest("img, .math-inline[data-tex], .math-display[data-tex], [data-diagram]");
}

// ── The overlay and the two handles ────────────────────────────────────────
//
// Appended to <body>, NOT into the reading surface. `.notes-rendered > *` is the
// incremental renderer's block-cache key (src/render/block-cache.js, and the
// comment at the top of styles/18-paged-notes.css), so a child of the notes view
// would invalidate every cached block on every render — the exact cost that
// cache exists to avoid.

function buildOverlay() {
  if (overlay) return;
  overlay = document.createElement("div");
  overlay.className = "touch-select-layer";
  overlay.setAttribute("aria-hidden", "true");
  handleStart = document.createElement("span");
  handleStart.className = "touch-select-handle is-start is-hidden";
  handleStart.innerHTML = '<i class="touch-select-bulb"></i>';
  handleEnd = document.createElement("span");
  handleEnd.className = "touch-select-handle is-end is-hidden";
  handleEnd.innerHTML = '<i class="touch-select-bulb"></i>';
  overlay.append(handleStart, handleEnd);
  document.body.appendChild(overlay);
  bindHandle(handleStart, "start");
  bindHandle(handleEnd, "end");
}

function destroyOverlay() {
  overlay?.remove();
  overlay = null;
  handleStart = null;
  handleEnd = null;
}

// The caret rectangle at one end of the range. A COLLAPSED clone rather than
// getClientRects()[0] / [n-1]: a collapsed range costs one rect no matter how
// much text is selected, where getClientRects() on a selection spanning a
// screenful of prose costs one per line fragment — and this runs every frame of
// a drag and on every scroll while a selection is up.
function edgeRect(range, atStart) {
  const probe = range.cloneRange();
  probe.collapse(atStart);
  const rect = probe.getBoundingClientRect();
  if (rect.height || rect.width) return rect;
  const rects = range.getClientRects();
  if (!rects.length) return null;
  return atStart ? rects[0] : rects[rects.length - 1];
}

// A boundary that has scrolled out of the reading surface does NOT lose its
// handle. It keeps one, PARKED against the edge it went off — flattened, so it
// reads as "the rest of this is up there" rather than as a grip sitting on the
// word beside it.
//
// Hiding it outright was the obvious thing and it is what made "scroll down and
// keep selecting" impossible: past one screenful there was no grip left on
// screen to grab, and the only way to extend was to scroll back to the one that
// had gone. Grabbing a parked handle drags from wherever the finger is (see
// grabOffsetY in bindHandle), which is what the reader means by grabbing it.
function hideHandle(handle) {
  handleMisses.delete(handle);
  handle.classList.add("is-hidden");
  // Parked is a claim about WHERE a visible grip is; leaving it set on a hidden
  // one leaves the claim standing for the next placement to trip over.
  handle.classList.remove("is-parked");
  handle.dataset.parked = "";
}

// ── Hysteresis, because both of these classes drive a 90ms fade ────────────
//
// styles/32-touch-select.css:136 gives .touch-select-handle
// `transition: opacity 90ms linear`, and THREE rules write that one property:
// is-touch-scrolling to 0, is-parked to 0.75, is-hidden to 0. So a class that
// flips per frame is not a flipped class, it is a pulsing grip — and both of
// these were computed from scratch on every animation frame, from a bare
// threshold with nothing to stop a boundary resting on it from crossing back
// and forth. `is-parked` also swaps the bulb's geometry
// (styles/32-touch-select.css:226) with no transition at all, so a flip is a
// shape change as well as a fade. That is the "the handles flicker" report.
//
// A boundary sits exactly on the edge of the surface for the whole of an edge
// auto-scroll, and again whenever the reader holds a grip near the bottom of
// the screen — which is to say, in the two situations where the grip matters
// most.
export const HANDLE_PARK_EXIT_PX = 8;

// How many consecutive unplaceable frames before a grip is actually taken off
// the glass. A single null edgeRect is a measurement artefact — a boundary in a
// subtree that has just had containment reapplied, a rect read in the frame
// between two layouts — not the boundary going away. A selection that has
// genuinely ended goes through hideHandles()/clearTouchSelection() and never
// waits for this.
export const HANDLE_MISS_FRAMES = 3;

const handleMisses = new WeakMap();

function noteHandleMiss(handle) {
  const misses = (handleMisses.get(handle) || 0) + 1;
  handleMisses.set(handle, misses);
  // Under the threshold the grip keeps its last placement: it is still drawn
  // where it was, which is where the boundary almost certainly still is.
  if (misses >= HANDLE_MISS_FRAMES) hideHandle(handle);
}

function placeHandle(handle, rect, box, horizontal) {
  if (!handle) return;
  if (!rect) {
    noteHandleMiss(handle);
    return;
  }
  let left = rect.left;
  let top = rect.top;
  const wasParked = handle.dataset.parked === "1";
  // A dead band, and it is deliberately asymmetric: park the moment the
  // boundary leaves the box, un-park only once it is well back inside. Entering
  // late would leave a grip drawn over the toolbar; leaving early is what makes
  // it flutter.
  const exit = wasParked ? HANDLE_PARK_EXIT_PX : 0;
  let parked = false;
  if (top < box.top) { top = box.top; parked = true; }
  else if (top + rect.height > box.bottom) { top = box.bottom - rect.height; parked = true; }
  else if (wasParked && (top < box.top + exit || top + rect.height > box.bottom - exit)) parked = true;
  // Paged mode scrolls sideways, so a boundary leaves by the left or right edge
  // rather than the top or bottom and the parking axis follows the mode.
  if (horizontal) {
    if (left < box.left) { left = box.left; parked = true; }
    else if (left > box.right) { left = box.right; parked = true; }
    else if (wasParked && (left < box.left + exit || left > box.right - exit)) parked = true;
  } else if (left < box.left - 24 || left > box.right + 24) {
    // Off the side in a vertically scrolling view is not a scroll position, it
    // is a boundary in something laid out off to one side. Nothing to park to.
    noteHandleMiss(handle);
    return;
  }
  handleMisses.delete(handle);
  handle.classList.remove("is-hidden");
  handle.classList.toggle("is-parked", parked);
  handle.dataset.parked = parked ? "1" : "";
  // transform rather than left/top: the handle is written on every frame of a
  // drag and on every scroll settle, and a transform is the one way to move a
  // box that costs no layout.
  handle.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  handle.style.height = `${Math.max(Math.round(rect.height), 12)}px`;
}

export function updateHandles() {
  if (!overlay) return;
  if (!rangeStillLive()) {
    if (liveRange) clearTouchSelection({ keepDocumentSelection: true });
    return;
  }
  // Read once for both handles: this runs on every frame of a drag, and
  // contentBox() is a rect read plus a computed-style read.
  const box = contentBox(liveRoot);
  const horizontal = edgeAxisIsHorizontal(liveRoot);
  const startRect = edgeRect(liveRange, true);
  // Where the selection is on the GLASS, captured off a rect this pass already
  // had to read. onRootScroll compares against it to tell a scroll the reader
  // made from one the app made — see selectionMovedOnGlass.
  lastGlassTop = startRect ? startRect.top : NaN;
  placeHandle(handleStart, startRect, box, horizontal);
  placeHandle(handleEnd, edgeRect(liveRange, false), box, horizontal);
}

// ── Telling the reader's scrolling from the app's ──────────────────────────
//
// onRootScroll fades both grips off the glass for the duration of a scroll,
// because a fixed overlay moved by JavaScript can only ever trail a surface
// scrolling on the compositor. That is right for a scroll the READER made and
// wrong for one the app made: settleNotesPin corrects scrollTop after an edit,
// measureNotesChunkEstimate changes heights above the viewport and the browser's
// own scroll anchoring compensates by writing scrollTop — and in every one of
// those the content does not move, so there is nothing for a grip to trail. The
// reader just sees both grips blink.
//
// scrollDrift below was rewritten for exactly this class of false positive on
// the press timer: measure the CONTENT, not scrollTop. This is the same idea for
// the fade, using the boundary's own position, which updateHandles has already
// read this frame.
export const SCROLL_GLASS_TOLERANCE_PX = 2;

let lastGlassTop = NaN;

function selectionMovedOnGlass() {
  if (!rangeStillLive()) return true;
  const rect = edgeRect(liveRange, true);
  // No readable boundary — no opinion. Fading is the older, safer answer.
  if (!rect) return true;
  const was = lastGlassTop;
  lastGlassTop = rect.top;
  if (!Number.isFinite(was)) return true;
  return Math.abs(rect.top - was) > SCROLL_GLASS_TOLERANCE_PX;
}

function hideHandles() {
  if (handleStart) hideHandle(handleStart);
  if (handleEnd) hideHandle(handleEnd);
}

// The single frame callback. `extendTo` is only run when a drag asked for it;
// the handles are placed either way, because a scroll settling is a reason to
// move them and not a reason to move the selection.
function runFrame() {
  const wantsExtend = frameWantsExtend;
  frameWantsExtend = false;
  if (wantsExtend && framePoint && touchSelectionIsDragging()) extendTo(framePoint.x, framePoint.y);
  updateHandles();
}

function scheduleFrame(wantsExtend = false) {
  if (wantsExtend) frameWantsExtend = true;
  // The edge-scroll loop already runs exactly one pass per frame, and it runs
  // the same body — a second rAF alongside it would double the work and land a
  // frame late.
  if (frameHandle || edgeFrame) return;
  frameHandle = requestAnimationFrame(() => {
    frameHandle = 0;
    runFrame();
  });
}

function scheduleHandleUpdate() {
  scheduleFrame(false);
}

// A scroll with a selection on screen: take the handles off the glass for the
// duration rather than letting them chase the text a frame behind it, and place
// them again once the view has been still for SCROLL_SETTLE_MS.
//
// Not during a drag. There the surface is being scrolled BY the gesture (the
// edge auto-scroll), the reader is holding the handle they are watching, and it
// has to stay under their thumb.
function onRootScroll(event) {
  // Only the surface the finger is actually on. Another view scrolling — a card
  // face behind the note, say — has a scroll offset this baseline knows nothing
  // about, and comparing against it would cancel a press for no reason.
  // A scroll event is the cheapest signal that the page is moving, and it
  // arrives before the next frame does. Measured against the drift watcher's
  // running reference, so this asks the same question the watcher asks —
  // "has it moved since the last frame" — rather than the one that used to
  // cancel a press for a note that had merely finished arriving.
  if (pressActive && event.currentTarget === pressRoot
      && (scrollDrift(pressRoot) > PRESS_SCROLL_TOLERANCE_PX
          || pressDriftTotal > PRESS_SETTLE_MAX_PX)) {
    cancelPress();
  }
  if (touchSelectionIsDragging()) {
    scheduleFrame(false);
    return;
  }
  if (!liveRange) return;
  // A scroll the APP made, announced by whoever made it. Cheapest test, and it
  // covers settleNotesPin and every other markProgrammaticNotesScroll() caller
  // without reading any geometry at all.
  const announced = isProgrammaticNotesScroll();
  // ...and one it did not announce, which scroll anchoring produces whenever
  // something above the viewport changes height. The content is the authority.
  if (announced || !selectionMovedOnGlass()) {
    // No fade — a fade is for a surface moving under the reader, and neither of
    // these is one. The grips still have to be PLACED, though: an announced
    // scroll does move the content, it just does so on the app's behalf. Not
    // scheduling that frame left them behind by however far the app scrolled,
    // which is a worse bug than the blink this branch exists to prevent.
    if (announced) scheduleFrame(false);
    return;
  }
  // The class alone, not is-hidden: the handles keep their boxes and fade,
  // which means the settle below can place them at their NEW positions and let
  // them fade back in there. Removing them from the layout and putting them
  // back is what a blink is.
  document.body.classList.add("is-touch-scrolling");
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
  scrollSettleTimer = setTimeout(() => {
    scrollSettleTimer = 0;
    document.body.classList.remove("is-touch-scrolling");
    updateHandles();
  }, SCROLL_SETTLE_MS);
}

function endScrollFade() {
  if (scrollSettleTimer) {
    clearTimeout(scrollSettleTimer);
    scrollSettleTimer = 0;
  }
  document.body.classList.remove("is-touch-scrolling");
}

// ── Committing a range ─────────────────────────────────────────────────────

function pointsToRange(a, b) {
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(a.node, a.offset);
    const other = document.createRange();
    other.setStart(b.node, b.offset);
    // Which of the two comes first in the document decides which is the range's
    // start. A drag that crosses its own anchor flips this every frame, which is
    // exactly the behaviour the native handles have.
    if (range.compareBoundaryPoints(Range.START_TO_START, other) <= 0) {
      range.setEnd(b.node, b.offset);
    } else {
      range.setStart(b.node, b.offset);
      range.setEnd(a.node, a.offset);
    }
  } catch (_) {
    return null;
  }
  return range;
}

// Push our range into the real Selection. Everything downstream — the pill, the
// highlight tools, the cloze driver, the paged-snap guard — reads the selection
// and its range, and all of that keeps working over user-select: none content.
// Only Selection.toString() does not, which is why nothing in this app calls it
// any more.
function mirrorToSelection() {
  if (!liveRange || !anchorPoint || !focusPoint) return;
  const selection = window.getSelection();
  if (!selection) return;
  try {
    selection.setBaseAndExtent(anchorPoint.node, anchorPoint.offset, focusPoint.node, focusPoint.offset);
  } catch (_) {
    try {
      selection.removeAllRanges();
      selection.addRange(liveRange.cloneRange());
    } catch (_) { /* the DOM moved under us; the next update repairs it */ }
  }
}

// Put the Range back into a Selection that lost it, if this is a moment where
// losing it means something went wrong rather than that the reader let go.
// Answers true when it repaired, false to say "this collapse is real".
//
// Four conditions, and every one of them is load-bearing:
//
//   • The selection was COLLAPSED TO A CARET — rangeCount is still 1 and the
//     one range is empty. That is the signature of the thing being defended
//     against and of nothing else: Chrome answering the compatibility mousedown
//     by placing a caret where the finger lifted. Every deliberate dismissal in
//     this app goes through removeAllRanges() instead, which leaves rangeCount
//     at 0 — so the two are told apart by what they DID rather than by when
//     they happened, and a reader who taps Copy 200ms after finishing a drag is
//     never argued with.
//   • A gesture is in flight, or ended less than SELECTION_DEFEND_MS ago.
//   • rangeStillLive(). If the Range's own nodes have been detached there is
//     nothing to put back, and clearing is the honest answer.
//   • Not already repaired within SELECTION_DEFEND_GAP_MS. mirrorToSelection()
//     fires selectionchange itself, so without this the repair would answer its
//     own echo; and a collapse that survives one repair is not one more repairs
//     will fix.
function defendSelection(selection) {
  if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
  if (!rangeStillLive()) return false;
  const now = performance.now();
  if (now - defendedAt < SELECTION_DEFEND_GAP_MS) return false;
  const defending = touchSelectionIsDragging()
    || (selectionDefendedUntil && now < selectionDefendedUntil);
  if (!defending) return false;
  defendedAt = now;
  // Deliberately NOT markProgrammaticNotesSelection(). That is the right
  // statement for anchors.js, which pushes a range in to show a reader where a
  // jump landed and does not want a formatting bar over it — and it suppresses
  // the pill for NOTES_PROGRAMMATIC_SELECTION_MS, 1500 of them. Here the pill
  // is the entire point: this repair exists so that a selection the reader made
  // is still there to act on, and hiding the bar over it for a second and a half
  // would be the same bug wearing a different face.
  //
  // Nothing needs telling either way. selection.js only infers a gesture from
  // selectionchange when the touch controller has NOT armed (see
  // setTouchSelectionArmed), and this function only ever runs when it has.
  mirrorToSelection();
  return true;
}

// Registration, not painting: what is painted comes out of the Range, and the
// Range is LIVE. Re-registering it on every drag frame — clear() then add() of
// the same object — invalidated the whole highlight sixty times a second to
// arrive at the registration it already had. The new-range case is the only one
// that has to touch the set.
function paintTouchHighlight() {
  if (!liveRange) return;
  if (!touchHighlight) {
    touchHighlight = new window.Highlight();
    window.CSS.highlights.set(HIGHLIGHT_NAME, touchHighlight);
  }
  if (paintedRange === liveRange) return;
  touchHighlight.clear();
  touchHighlight.add(liveRange);
  paintedRange = liveRange;
}

function setSelectionPoints(anchor, focus, root) {
  const range = pointsToRange(anchor, focus);
  if (!range || range.collapsed) return false;
  liveRoot = root;
  liveRange = range;
  anchorPoint = anchor;
  focusPoint = focus;
  paintTouchHighlight();
  mirrorToSelection();
  buildOverlay();
  document.body.classList.add("is-touch-selecting");
  updateHandles();
  return true;
}

export function clearTouchSelection({ keepDocumentSelection = false } = {}) {
  stopEdgeScroll();
  if (frameHandle) {
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
  frameWantsExtend = false;
  framePoint = null;
  lastExtendX = NaN;
  lastExtendY = NaN;
  dismissPending = false;
  endScrollFade();
  liveRange = null;
  liveRoot = null;
  anchorPoint = null;
  focusPoint = null;
  draggingHandle = "";
  pressDragging = false;
  grabOffsetY = 0;
  setTouchSelectionDragging(false);
  // The selection is gone, so nothing is standing down for it any more —
  // unless a finger is still on the glass. A press that is still resolving owns
  // the surface (this is also how a pill action dismisses, and one of those can
  // land inside a press window), and so does a rescued scroll, which is this
  // module driving the surface by hand until the finger lifts.
  if (!pressActive && !escapeScroll) setTouchGestureHoldsSurface(false);
  // ...and nothing left to defend, either.
  selectionDefendedUntil = 0;
  if (touchHighlight) touchHighlight.clear();
  paintedRange = null;
  document.body.classList.remove("is-touch-selecting");
  document.body.classList.remove("is-touch-dragging");
  hideHandles();
  clearSelectionStableRegion();
  if (!keepDocumentSelection) {
    try { window.getSelection()?.removeAllRanges(); } catch (_) { /* nothing selected */ }
  }
}

// ── Edge auto-scroll ───────────────────────────────────────────────────────
//
// Extending a selection past the bottom of the screen is done by dragging a
// handle there and letting the view come to you. The native controller does
// this; without it a selection can never be longer than one screenful.
//
// Paged mode scrolls sideways (src/notes/paged-view.js drives it with
// scrollLeft), so the axis follows the mode rather than being assumed.

function edgeAxisIsHorizontal(root) {
  return root.classList.contains("is-paged");
}

function startEdgeScroll() {
  if (edgeFrame) return;
  const step = () => {
    edgeFrame = 0;
    if (!edgeVector || !liveRoot || !edgePoint) return;
    // Announced, because it is the APP scrolling and not the reader.
    //
    // Every one of these writes fires a real scroll event on #notesView, and
    // four listeners answer it: the reading-anchor capture (src/main.js), the
    // paged page-settle (src/notes/paged-view.js), the mark menu's dismissal
    // and the pill's. Unannounced, all four ran on every frame of a drag — a
    // hit-test and a block-cache walk among them — on the exact frames the
    // reader is dragging in, and on a note built as it is read a stalled
    // renderer is what lets the compositor take the gesture away (see
    // gestureStolen). onRootScroll is unaffected: it takes its dragging branch
    // before it ever asks whether the scroll was announced.
    markProgrammaticNotesScroll();
    if (edgeAxisIsHorizontal(liveRoot)) liveRoot.scrollLeft += edgeVector;
    else liveRoot.scrollTop += edgeVector;
    // The finger has not moved — the CONTENT has — so the same point resolves
    // to a new caret every frame and the "did the point change" guard in
    // extendTo must not apply. runFrame() extends and places the handles in one
    // pass, which is the same body scheduleFrame() runs.
    framePoint = edgePoint;
    frameWantsExtend = true;
    lastExtendX = NaN;
    lastExtendY = NaN;
    runFrame();
    edgeFrame = requestAnimationFrame(step);
  };
  edgeFrame = requestAnimationFrame(step);
}

function stopEdgeScroll() {
  if (edgeFrame) cancelAnimationFrame(edgeFrame);
  edgeFrame = 0;
  edgeVector = 0;
  edgePoint = null;
  if (edgeArmTimer) clearTimeout(edgeArmTimer);
  edgeArmTimer = 0;
  edgeEnteredAt = NaN;
}

// ── The dwell ──────────────────────────────────────────────────────────────
//
// The band arms EDGE_ARM_MS after the finger enters it, not on the touchmove
// that took it in. See EDGE_ARM_MS for why an instant band reads to a reader as
// the page being taken away from them.
//
// A timer rather than a check inside the step loop, and that is not a detail: a
// finger HOLDING at the edge is the case the auto-scroll exists for, and a
// finger holding still sends no touchmoves at all — so a dwell evaluated only
// on movement would never complete for the one gesture it must not break.
//
// It also has to be a timer rather than an rAF loop that idles until it arms,
// because scheduleFrame() stands down whenever edgeFrame is set, on the
// understanding that the edge loop is running runFrame() itself. A loop that
// was awake but deliberately doing nothing would swallow the drag's own
// extends for the length of the dwell.

// How fast the view should travel for a finger at this point: zero outside the
// band, ramping linearly to EDGE_MAX_SPEED_PX at the very edge.
function edgeVectorFor(x, y) {
  if (!liveRoot) return 0;
  const bounds = liveRoot.getBoundingClientRect();
  const horizontal = edgeAxisIsHorizontal(liveRoot);
  const near = horizontal ? bounds.left : bounds.top;
  const far = horizontal ? bounds.right : bounds.bottom;
  const along = horizontal ? x : y;
  if (along < near + EDGE_PX) {
    return -EDGE_MAX_SPEED_PX * Math.min(1, (near + EDGE_PX - along) / EDGE_PX);
  }
  if (along > far - EDGE_PX) {
    return EDGE_MAX_SPEED_PX * Math.min(1, (along - (far - EDGE_PX)) / EDGE_PX);
  }
  return 0;
}

// Re-read from the finger's LATEST position rather than from the one that
// started the dwell: a thumb that spent those 120ms sliding further into the
// band should leave at the speed it is actually at, not the one it came in at.
function armEdgeScroll() {
  if (edgeArmTimer) clearTimeout(edgeArmTimer);
  edgeArmTimer = 0;
  if (!edgePoint || !liveRoot || !touchSelectionIsDragging()) return;
  edgeVector = Math.round(edgeVectorFor(edgePoint.x, edgePoint.y));
  if (edgeVector) startEdgeScroll();
}

function updateEdgeScroll(x, y, at = performance.now()) {
  if (!liveRoot) return;
  const vector = edgeVectorFor(x, y);
  // Out of the band: everything stops and the clock is thrown away, so coming
  // back in has to serve the dwell again.
  if (!vector) { stopEdgeScroll(); return; }
  edgePoint = { x, y };
  // Already scrolling — only the speed changes as the finger moves within the
  // band. The dwell is served once per entry, not once per touchmove.
  if (edgeFrame) { edgeVector = Math.round(vector); return; }
  // First frame inside the band: start the clock and let the timer arm it, so a
  // finger that then holds perfectly still — which is the gesture this exists
  // for, and which sends no further moves — still gets its scroll.
  if (!(edgeEnteredAt <= at)) {
    edgeEnteredAt = at;
    if (edgeArmTimer) clearTimeout(edgeArmTimer);
    edgeArmTimer = setTimeout(armEdgeScroll, EDGE_ARM_MS);
    return;
  }
  // In the band, dwell already served, and nothing running. That is not a
  // no-op: the speed ramps to zero at the INNER rim of the band, so a finger
  // that dwelled at the very edge of it armed a vector that rounded to zero and
  // the loop stopped on its first pass. Without this, moving deeper in would
  // find the clock already started, the loop already finished, and the edge
  // scroll dead for the rest of the gesture.
  if (at - edgeEnteredAt >= EDGE_ARM_MS) armEdgeScroll();
}

// ── Extending ──────────────────────────────────────────────────────────────

function extendTo(x, y) {
  if (!anchorPoint || !rangeStillLive()) return;
  // A finger that has not moved a whole pixel since the last frame resolves to
  // the same caret, and the work of proving that is the expensive part: a
  // hit-test plus a binary search that forces layout at every step.
  if (Math.abs(x - lastExtendX) < 1 && Math.abs(y - lastExtendY) < 1) return;
  lastExtendX = x;
  lastExtendY = y;
  const caret = caretInRoot(x, y, liveRoot);
  if (!caret) return;
  const next = pointsToRange(anchorPoint, caret);
  if (!next || next.collapsed) return;
  focusPoint = caret;
  liveRange.setStart(next.startContainer, next.startOffset);
  liveRange.setEnd(next.endContainer, next.endOffset);
  // The Range is live and already registered with the Highlight, so this is an
  // identity check on a drag frame — the repaint follows the mutation above.
  paintTouchHighlight();
  mirrorToSelection();
  // Re-marked on every step, not once at the start of the drag: the chunk that
  // matters is the one being dragged INTO, and it is not known until the
  // boundary reaches it. Cheap to repeat — markSelectionStableRegion() compares
  // the wanted set against the marked one and touches no DOM when they match,
  // which is the overwhelmingly common case within a single paragraph.
  //
  // growOnly, because this is a drag: a chunk the selection has moved OFF is
  // handed its containment back at the end of the gesture and not in the middle
  // of one, where re-containing it is a style invalidation over everything
  // inside it on the frame the reader is dragging in.
  markSelectionStableRegion({ growOnly: true });
}

function beginDrag() {
  setTouchSelectionDragging(true);
  // Held for the drag as well as for the press window that preceded it. A press
  // that fired already set this; a HANDLE drag starts here with no press behind
  // it, so this is the only place that arms it for one.
  setTouchGestureHoldsSurface(true);
  // A drag that starts mid-fling inherits the faded handles; the reader is
  // holding one, so it comes back now rather than on the settle timer.
  endScrollFade();
  // The class that locks the surface. Distinct from `is-touch-selecting`, which
  // means only that a selection EXISTS: a reader who has selected something and
  // wants to scroll down to see the rest of it must be able to, and keying the
  // touch-action lock to the selection rather than to the drag took that away —
  // the note simply stopped scrolling until the selection was dismissed.
  document.body.classList.add("is-touch-dragging");
  hideNotesSelectionButton();
  // The same containment suspension 960ec1e added, driven from the gesture
  // instead of guessed at from a burst of selectionchange events: we know
  // exactly when a drag starts now.
  markSelectionStableRegion({ growOnly: true });
}

function endDrag() {
  stopEdgeScroll();
  if (frameHandle) {
    cancelAnimationFrame(frameHandle);
    frameHandle = 0;
  }
  frameWantsExtend = false;
  framePoint = null;
  lastExtendX = NaN;
  lastExtendY = NaN;
  draggingHandle = "";
  pressDragging = false;
  grabOffsetY = 0;
  // Re-contain BEFORE the dragging flag drops. clearSelectionStableRegion()
  // changes heights, the browser's scroll anchoring answers that by writing
  // scrollTop, and a scroll arriving with the guard already down is one
  // onRootScroll would take the fade branch for — a blink at the end of every
  // drag. selectionMovedOnGlass() would catch it anyway; the ordering means it
  // never has to.
  clearSelectionStableRegion();
  setTouchSelectionDragging(false);
  // ...and hand the surface back, which is what pays for everything that stood
  // down for the gesture: the viewport renderer builds the spans it queued, and
  // settleNotesPin is free to correct again. Only if no press is still pending —
  // a drag ending inside another finger's press window is not a thing this
  // controller allows (a second finger cancels the press), but the test is
  // cheap and a stuck flag is expensive. See src/core/gesture.js.
  if (!pressActive) setTouchGestureHoldsSurface(false);
  document.body.classList.remove("is-touch-dragging");
  updateHandles();
  // Straight to the real thing: the 300ms quiet window in selection.js was only
  // ever a way of guessing that a native handle had been let go, and a handle we
  // drew tells us directly.
  positionNotesSelectionButton();
  // The window in which a stray collapse is answered by re-mirroring rather
  // than by throwing the selection away. See the selectionchange listener in
  // initTouchSelection.
  selectionDefendedUntil = performance.now() + SELECTION_DEFEND_MS;
}

// ── The handles' own gestures ──────────────────────────────────────────────
//
// Touch events are delivered to the element the touch STARTED on for the whole
// gesture, so a listener on the handle keeps receiving moves after the finger
// has left it — which is what a drag is. Non-passive, because preventDefault
// here is what stops the reading surface scrolling under the drag.

function bindHandle(handle, which) {
  handle.addEventListener("touchstart", (event) => {
    if (!rangeStillLive()) return;
    event.preventDefault();
    event.stopPropagation();
    draggingHandle = which;
    // Grabbing a handle pins the OTHER end. Recomputed from the range rather
    // than trusting anchorPoint, because the previous drag may have swapped
    // them.
    anchorPoint = which === "start"
      ? { node: liveRange.endContainer, offset: liveRange.endOffset }
      : { node: liveRange.startContainer, offset: liveRange.startOffset };
    // Measure the grab rather than assuming it: the distance from the fingertip
    // to the caret this handle marks depends on the line's height and on where
    // in the bulb the thumb landed. A constant that is out by half a line is
    // exactly the "indicators are wrong" complaint, reintroduced by us.
    //
    // Except for a PARKED handle, whose caret is off screen: there the offset
    // would be the distance to a boundary somewhere above the fold, and the
    // reader means "bring the boundary here". The finger is the caret.
    const touch = event.touches[0];
    const rect = edgeRect(liveRange, which === "start");
    grabOffsetY = handle.dataset.parked
      ? 0
      : ((touch && rect) ? touch.clientY - (rect.top + rect.height / 2) : HANDLE_GRAB_OFFSET_PX);
    // A grip's own touchstart is preventDefault()ed above, so the browser can
    // never take THIS sequence. The flag is reset anyway: it belongs to the
    // gesture, and the gesture starts here.
    gestureStolen = false;
    edgeEnteredAt = NaN;
    beginDrag();
  }, { passive: false });

  handle.addEventListener("touchmove", (event) => {
    if (draggingHandle !== which) return;
    // Should not happen — the touchstart on the grip was cancelled, so the
    // sequence stayed ours — but if the browser ever does take it, the same
    // answer as a press-drag: end the drag and leave the selection standing
    // rather than smear its boundary across a page we cannot hold still.
    if (!event.cancelable) {
      gestureStolen = true;
      endDrag();
      return;
    }
    event.preventDefault();
    const touch = event.touches[0];
    if (!touch) return;
    const y = touch.clientY - grabOffsetY;
    framePoint = { x: touch.clientX, y };
    scheduleFrame(true);
    updateEdgeScroll(touch.clientX, y, moveTime(event));
  }, { passive: false });

  ["touchend", "touchcancel"].forEach((type) => {
    handle.addEventListener(type, (event) => {
      if (draggingHandle !== which) return;
      event.preventDefault();
      endDrag();
    }, { passive: false });
  });
}

// ── The press ──────────────────────────────────────────────────────────────

// When a touch event was GENERATED, not when its handler got to run, expressed
// on the same clock as pressFiredAt.
//
// The difference between generated and delivered is the whole point — see
// PRESS_ESCAPE_PX. The two CLOCKS are the part that needs care. `event.timeStamp`
// is specified as a DOMHighResTimeStamp against the same time origin as
// performance.now(), and on a real device it is; but it is produced by the input
// pipeline rather than read from the same call, so the two are not guaranteed to
// agree to the millisecond, and pressFiredAt is a performance.now() reading taken
// in a setTimeout. Measured under CDP-driven touch input, the gap was tens of
// milliseconds — a quarter of PRESS_ESCAPE_MS, spent on nothing.
//
// So the offset is measured once per gesture, on the touchstart, and subtracted.
// Whatever constant difference the two clocks have then cancels, and what
// survives is exactly the quantity wanted: how long after the press this move was
// made. If touchstart itself was delivered late, the press timer started late by
// the same amount and the two still agree.
let eventClockSkew = 0;

// Anything that cannot be a DOMHighResTimeStamp for this document — most
// importantly a UA (or a synthetic event) reporting epoch milliseconds, ~1.8e12,
// which would make every gesture look like it happened days after the press.
// A skew that large is not a skew; drop back to reading the clock ourselves and
// lose only the jank immunity.
const CLOCK_SKEW_LIMIT_MS = 1000;

function calibrateEventClock(event) {
  const stamp = event?.timeStamp;
  if (typeof stamp !== "number" || !Number.isFinite(stamp)) { eventClockSkew = 0; return; }
  const skew = stamp - performance.now();
  eventClockSkew = Math.abs(skew) > CLOCK_SKEW_LIMIT_MS ? 0 : skew;
}

function moveTime(event) {
  const now = performance.now();
  const stamp = event?.timeStamp;
  if (typeof stamp !== "number" || !Number.isFinite(stamp)) return now;
  const at = stamp - eventClockSkew;
  // A corrected stamp in the future, or before the page loaded, means the
  // calibration did not hold — a second pointer, a re-dispatched event. The
  // clock we can always trust is the one we are holding.
  if (!(at >= 0) || at > now + CLOCK_SKEW_LIMIT_MS) return now;
  return at;
}

function cancelPress() {
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = null;
  pressActive = false;
  stopPressDrift();
  // Dropped rather than left behind: a note re-renders by replacing its blocks,
  // and holding the old one would keep a detached subtree alive for no reason.
  pressAnchor = null;
  // The surface is ours for as long as a press might still become a selection,
  // and no longer. Every other exit from a gesture goes through endDrag() or
  // clearTouchSelection(), which release it too — see src/core/gesture.js for
  // why a stuck flag would be worse than the bug it is fixing.
  if (!touchSelectionIsDragging()) setTouchGestureHoldsSurface(false);
}

// Hand a mistaken press back to the reader as the scroll they meant.
//
// Dropping the selection is only half of it. By the time the escape fires we
// have already called preventDefault on a move or two of this gesture, and
// Chrome does not give a gesture back once that has happened — the browser's
// own scroller is out for the rest of the touch, however passive we go now. So
// the finger would sit on a surface that had stopped responding, which reads as
// a freeze rather than as a correction.
//
// We scroll it ourselves instead, one delta per move, until the finger lifts.
// No fling at the end of it — a rescued scroll is a short deliberate drag, and
// the next flick gets the browser's own scroller back with all of its momentum.
// Both axes, because the paged reading mode scrolls sideways; the axis a
// surface cannot scroll ignores the assignment.
function beginEscapeScroll(root, touch) {
  // Assigned BEFORE the clear, so clearTouchSelection() can see that this
  // gesture is not over. Otherwise it hands the surface back — draining every
  // span the viewport renderer had queued, synchronously, on the frame the
  // reader has just started scrolling in — and we would have to take it away
  // again immediately afterwards, with the work already done.
  escapeScroll = { root, x: touch.clientX, y: touch.clientY };
  clearTouchSelection();
  hideNotesSelectionButton();
}

// The slop around the selection that still counts as "on it". Generous on
// purpose: the reader aiming here is reaching for a handle, and a miss used to
// throw the whole selection away.
export const SELECTION_HIT_SLOP_PX = 12;

function pointInSelection(x, y) {
  if (!rangeStillLive()) return false;
  // The union first. getClientRects() on a selection spanning a screenful of
  // prose is one rect per line FRAGMENT, and this runs on every touchstart —
  // including the one that starts an ordinary scroll. The union is a single rect
  // and rejects the overwhelming majority of points outright.
  const union = liveRange.getBoundingClientRect();
  if (x < union.left - SELECTION_HIT_SLOP_PX || x > union.right + SELECTION_HIT_SLOP_PX
      || y < union.top - SELECTION_HIT_SLOP_PX || y > union.bottom + SELECTION_HIT_SLOP_PX) {
    return false;
  }
  const rects = liveRange.getClientRects();
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (x >= r.left - SELECTION_HIT_SLOP_PX && x <= r.right + SELECTION_HIT_SLOP_PX
        && y >= r.top - SELECTION_HIT_SLOP_PX && y <= r.bottom + SELECTION_HIT_SLOP_PX) return true;
  }
  return false;
}

// How far the reading surface may move under a resting finger and still leave
// the press standing. Not zero, deliberately: a note's own layout settles while
// it is being read — a chunk's estimated height resolving, a deferred table
// laying itself out, the browser's scroll anchoring compensating for either —
// and cancelling on those would put back the "I have to fight the long press"
// bug that two commits have now been spent on. Past this the page is visibly
// moving, and a reader watching it move is not making a selection.
export const PRESS_SCROLL_TOLERANCE_PX = 10;

// ── ...measured per FRAME, against a cap on the whole window ──────────────
//
// The tolerance above was measured from touchdown, once, at the moment the
// press resolved: total displacement over the whole 240ms. That asks "has the
// page ended up somewhere else", and the question the comment above states is
// "is the reader watching the page MOVE" — which are the same question only
// when the page is moving steadily.
//
// They come apart exactly where it matters. A note built as it is read is
// arriving while it is being read: jump into unread content and the blocks that
// come on screen swap `--notes-block-estimate` for their real heights, all
// inside the first frame or two. Measured on the 549KB fixture in
// tools/large-note-selection-check.mjs, deterministically: 16px in the first
// 100ms after touchdown and then perfectly still for the remaining 640ms — a
// page that had finished arriving before the press was due, and a press
// cancelled for it every single time. tools/large-note-selection-check.mjs
// documents the same settling at 30-50px and calls it what it is: the browser's
// own `content-visibility` work, identical on every build this app has ever had.
//
// So the drift reference is re-baselined every frame while a press is pending,
// and PRESS_SCROLL_TOLERANCE_PX now bounds movement since the LAST frame. A
// fling moves tens of pixels per frame and still cancels instantly; a settle
// spends its whole budget in one step and is spent.
//
// The cumulative cap is what stops that being a licence to drift: nine pixels a
// frame, fourteen frames, and the page has moved a screenful without ever
// tripping a per-frame test. Above the 30-50px of settling that check documents,
// well under a screen.
export const PRESS_SETTLE_MAX_PX = 64;

// The block under a point, for use as a drift reference. Deliberately a BLOCK
// rather than whatever `elementFromPoint` answered: an inline <em> or a <mark>
// can be replaced by a repaint while the paragraph around it survives, and a
// reference that vanishes costs us the measurement.
export function driftAnchorAt(x, y, root) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === root || !root.contains(hit)) return null;
  return hit.closest?.(rootBlockSelector(root)) || hit;
}

// ── "Has the page moved under this finger?" ────────────────────────────────
//
// This used to be `|scrollTop − scrollTop at touchstart|`, and scrollTop is the
// wrong quantity. The question the tolerance is asking is whether the reader is
// watching the page move, and on a note big enough to be chunked scrollTop moves
// precisely when the content does NOT: the browser's scroll anchoring adjusts it
// to hold the visible content still whenever something above the viewport
// changes height. Which is what measureNotesChunkEstimate does to every chunk
// that enters its runway, what a chunk laying out for the first time does
// anyway, and what pinChunkHeights (src/notes/selection.js) now does more of.
//
// So a finger resting on a perfectly still page had its press cancelled, over
// and over, on exactly the notes where the press is hardest to land. That is the
// "I have to press again and again" half of the report, and it cannot happen on
// a note too small to have chunks — which is why no small-fixture check ever saw
// it.
//
// Measuring the reference block's position on the glass answers the real
// question directly: scroll anchoring reads as zero movement, because zero
// movement is what it achieves. The scrollTop delta stays as the fallback for a
// gesture that never captured a reference (a press on the padding below the last
// block) or whose reference has been detached by a repaint.
function scrollDrift(root) {
  if (!root) return 0;
  if (pressAnchor && pressAnchor.isConnected && root.contains(pressAnchor)) {
    const rect = pressAnchor.getBoundingClientRect();
    return Math.abs(rect.top - pressAnchorTop) + Math.abs(rect.left - pressAnchorLeft);
  }
  return Math.abs(root.scrollTop - pressScrollTop) + Math.abs(root.scrollLeft - pressScrollLeft);
}

// Move the reference forward to where the content is NOW, adding what it moved
// to the running total. Returns that step, so the one caller that wants to act
// on it does not have to read the rect twice.
function rebasePressDrift(root) {
  const step = scrollDrift(root);
  pressDriftTotal += step;
  if (pressAnchor && pressAnchor.isConnected && root && root.contains(pressAnchor)) {
    const rect = pressAnchor.getBoundingClientRect();
    pressAnchorTop = rect.top;
    pressAnchorLeft = rect.left;
  } else if (root) {
    pressScrollTop = root.scrollTop;
    pressScrollLeft = root.scrollLeft;
  }
  return step;
}

// One rect read per frame for at most LONG_PRESS_MS. It runs only while a press
// is pending — a gesture that has already become a selection has its own frame
// loop and no reference to keep.
function watchPressDrift() {
  if (pressDriftFrame) return;
  const step = () => {
    pressDriftFrame = 0;
    if (!pressActive || !pressRoot) return;
    // Moving right now, or has moved far enough in total that wherever the
    // reader was aiming is no longer under their finger. Either way this is not
    // a press.
    if (rebasePressDrift(pressRoot) > PRESS_SCROLL_TOLERANCE_PX
        || pressDriftTotal > PRESS_SETTLE_MAX_PX) {
      cancelPress();
      return;
    }
    pressDriftFrame = requestAnimationFrame(step);
  };
  pressDriftFrame = requestAnimationFrame(step);
}

function stopPressDrift() {
  if (pressDriftFrame) cancelAnimationFrame(pressDriftFrame);
  pressDriftFrame = 0;
}

function firePress(root, x, y) {
  pressTimer = null;
  pressActive = false;
  stopPressDrift();
  if (!canTouchSelect()) return;
  // The browser has already committed this gesture to a scroll, so there is
  // nothing left for a press to own: the preventDefault that would hold the
  // surface still is a no-op, and so is the one on the touchend that keeps the
  // compatibility mousedown from collapsing what we selected. Firing anyway is
  // what produced a buzz with no selection behind it. The move handler normally
  // cancels the press before this runs; this is the frame where the two race.
  if (gestureStolen) { pressAnchor = null; setTouchGestureHoldsSurface(false); return; }
  // The surface is moving under the finger right now, so the reader is watching
  // the page move rather than choosing a word on a still one. Measured against
  // the last frame's reference rather than against touchdown — see
  // PRESS_SETTLE_MAX_PX — so a note that finished ARRIVING during the window
  // does not read as a note that is running away. The drift watcher normally
  // cancels the press before this runs; this is for the frame where the two race.
  if (scrollDrift(root) > PRESS_SCROLL_TOLERANCE_PX
      || pressDriftTotal > PRESS_SETTLE_MAX_PX) {
    pressAnchor = null;
    setTouchGestureHoldsSurface(false);
    return;
  }
  pressAnchor = null;
  // Whatever was selected is about to be replaced, so there is nothing left to
  // dismiss on the way up.
  dismissPending = false;
  // Stamped before the selection is made rather than after, so the escape
  // window covers the word snap and the first paint too — the reader's finger
  // starts leaving from the moment they feel the buzz, not from the moment we
  // finish drawing.
  pressFiredAt = performance.now();
  // ...and the point the escape is measured from, which is where the finger is
  // NOW rather than where it landed 240ms ago. See PRESS_ESCAPE_PX.
  pressFiredX = x;
  pressFiredY = y;

  // The card swipe recogniser stands down EXPLICITLY now. Its own dwell timer
  // (swipe.js, longPressGraceMs) still exists for the native fallback path, but
  // when we own the gesture there is nothing to infer — we know a press just
  // became a selection, and updateSwipe's preventDefault must not run again for
  // this finger.
  resetCardDrag();

  const atomic = atomicAt(x, y, root);
  if (atomic) {
    const range = document.createRange();
    try { range.selectNode(atomic); } catch (_) { return; }
    if (setSelectionPoints(
      { node: range.startContainer, offset: range.startOffset },
      { node: range.endContainer, offset: range.endOffset },
      root
    )) {
      navigator.vibrate?.(8);
      pressDragging = true;
      beginDrag();
    }
    return;
  }

  const caret = caretInRoot(x, y, root);
  if (!caret) return;
  const bounds = wordBoundsAt(caret.node.nodeValue || "", caret.offset);
  const start = bounds ? bounds.start : Math.max(0, caret.offset - 1);
  const end = bounds ? bounds.end : Math.min((caret.node.nodeValue || "").length, caret.offset + 1);
  if (start === end) return;
  if (!setSelectionPoints({ node: caret.node, offset: start }, { node: caret.node, offset: end }, root)) return;

  navigator.vibrate?.(8);
  // The finger that pressed keeps extending, exactly as it does natively:
  // press, then slide without lifting.
  pressDragging = true;
  anchorPoint = { node: caret.node, offset: start };
  focusPoint = { node: caret.node, offset: end };
  beginDrag();
}

function onRootTouchStart(event) {
  // Any new finger ends a rescued scroll: the one that was doing it has lifted,
  // or a second has joined it to pinch.
  escapeScroll = null;
  if (!canTouchSelect()) return;
  // A second finger. Not a press, and not a tap either — a pinch must not
  // dismiss the selection it is being zoomed over.
  if (event.touches.length !== 1) { cancelPress(); dismissPending = false; return; }
  const root = event.currentTarget;
  const touch = event.touches[0];

  // ── The browser has taken nothing from THIS sequence yet ──────────────────
  //
  // Up here, not down with the rest of the fresh-sequence state, because every
  // early return below it skips that block — and one of them is the guard for
  // an image's own controls a few lines down.
  //
  // Chrome marks touchmove non-cancelable the moment a scroll starts, so
  // onRootTouchMove latches this on every ordinary scroll of a note. Left
  // latched, the NEXT touch reached onRootTouchEnd with it still true, and that
  // handler answers `wasSelecting || gestureStolen` with preventDefault() —
  // which cancels the compatibility mouse sequence, so no click is ever
  // synthesised. The delete button and the Zoom pill are reached by a click, so
  // scrolling a note and then tapping 🗑 did nothing at all, while tapping a
  // paragraph first (which reaches the block below) and then 🗑 worked. That is
  // the whole of "sometimes the delete button doesn't work". The resize grip
  // was unaffected because it is driven by pointerdown.
  //
  // Only for a genuinely new single-finger sequence, which is why it sits after
  // the multi-touch guard above: a second finger joining a live drag must not
  // un-latch what that drag already lost.
  gestureStolen = false;

  // Not on an image's own controls. The resize grip takes pointer capture and
  // drags the corner of the picture, but this listener is passive and bound on
  // the reading root, so beginImageResize's preventDefault cannot reach it: a
  // finger resting on the grip for the 240ms before it starts to drag armed a
  // text press over the image at the same time as the resize. The grip is a
  // bare <div>, so it has to be named — the same reason src/cards/swipe.js and
  // src/notes/mark-menu.js name it.
  if (event.target?.closest?.(".notes-img-resize-handle, .notes-img-delete-btn, .notes-img-size-badge, .diagram-zoom")) {
    cancelPress();
    dismissPending = false;
    return;
  }

  // Region select is a drag of its own: the reader is drawing a box round a
  // figure, and a press that armed a text selection underneath it would buzz,
  // select a word and fight the marquee for the same finger. Asked of the DOM
  // rather than by importing isRegionSelectArmed — this module is reached from
  // the notes subtree and pulling the whole document subtree in behind it is
  // the reordering src/notes/selection.js's own document branch warns about.
  if (isDocumentSelectionRoot(root) && el.documentStage?.classList.contains("is-region-select")) {
    cancelPress();
    dismissPending = false;
    return;
  }

  // A touch that lands inside the current selection is a grab, not a new
  // selection — leave it alone so the reader can reach for a handle.
  //
  // A touch outside it MIGHT be a dismissal, and this is where that used to be
  // decided: `clearTouchSelection()`, on the touchstart, before anything was
  // known about the gesture. But a scroll begins with exactly this touch, and
  // scrolling to reach the rest of the passage you are selecting is the most
  // ordinary thing a reader does — so the selection was gone before their
  // finger had moved a pixel, which is "when I scroll to select more it forgets
  // the previous selections". A near-miss on a handle went the same way.
  //
  // So the decision is deferred to the touchEND, where the gesture is known: a
  // tap dismisses, a scroll does not. Chrome's own behaviour, and the reason
  // this was not simply a missing feature — a native selection survives a
  // scroll too.
  dismissPending = Boolean(liveRange) && !pointInSelection(touch.clientX, touch.clientY);

  pressOriginX = touch.clientX;
  pressOriginY = touch.clientY;
  pressX = touch.clientX;
  pressY = touch.clientY;
  pressRoot = root;
  pressScrollTop = root.scrollTop;
  pressScrollLeft = root.scrollLeft;
  // ...and the same baseline in content space, which is the one scrollDrift
  // actually prefers. Read once here rather than per scroll event: the rect is
  // only ever compared against itself.
  pressAnchor = driftAnchorAt(touch.clientX, touch.clientY, root);
  if (pressAnchor) {
    const rect = pressAnchor.getBoundingClientRect();
    pressAnchorTop = rect.top;
    pressAnchorLeft = rect.left;
  }
  // A fresh sequence: there is no previous move to measure a speed against, and
  // this touchstart is what calibrates the clock every later move of it will be
  // read on. (gestureStolen is reset at the top of this function instead — see
  // the comment there for why it cannot live down here.)
  calibrateEventClock(event);
  lastMoveX = NaN;
  lastMoveY = NaN;
  lastMoveAt = NaN;
  edgeEnteredAt = NaN;
  pressDriftTotal = 0;
  pressActive = true;
  // The press window counts as owning the surface, not just the drag after it.
  // A span build or a pin correction landing in these 240ms moves the content
  // and cancels the press — see src/core/gesture.js.
  setTouchGestureHoldsSurface(true);
  watchPressDrift();
  if (pressTimer) clearTimeout(pressTimer);
  pressTimer = setTimeout(() => firePress(root, pressX, pressY), LONG_PRESS_MS);
}

// Non-passive, and it early-returns in two property reads when there is no
// gesture of ours in flight. The cost of a non-passive touchmove listener is a
// main-thread round trip on the FIRST move of a scroll, which this surface
// already pays — every reading surface here has a non-passive scroll consumer
// somewhere. The benefit is press-and-slide: without preventDefault the page
// scrolls out from under a selection the reader is still making, which is the
// single most common way a native selection gets lost.
function onRootTouchMove(event) {
  // The browser's own answer to "do we still own this gesture", read before
  // anything acts on it. Once false it stays false for the rest of the
  // sequence, so this is latched rather than sampled — a later move being
  // reported cancelable again would not give the scroll back.
  if (!event.cancelable) gestureStolen = true;
  const escapeAt = moveTime(event);
  // The rescued scroll, before anything else: this finger has already been
  // taken off a selection it never meant to make, and the surface is ours to
  // move until it lifts.
  if (escapeScroll) {
    const touch = event.touches[0];
    if (!touch) return;
    event.preventDefault();
    escapeScroll.root.scrollTop -= touch.clientY - escapeScroll.y;
    escapeScroll.root.scrollLeft -= touch.clientX - escapeScroll.x;
    escapeScroll.x = touch.clientX;
    escapeScroll.y = touch.clientY;
    return;
  }
  if (pressDragging) {
    const touch = event.touches[0];
    if (!touch) return;
    // The gesture is the browser's now, so preventDefault below cannot hold the
    // surface still and the page is going to move whatever we do. Extending a
    // selection across a flying page smears its endpoint across whatever
    // happens to pass under the finger, which is the reported "as soon as I try
    // to select more content it starts to scroll" — with the selection ruined
    // as well as the page moved.
    //
    // So the drag ends here and the selection STAYS on the words it already
    // had. The reader keeps what they pressed for and can adjust it with the
    // grips once the surface stops. Not clearTouchSelection(): losing the
    // selection is the complaint, and there is nothing wrong with it.
    if (gestureStolen) {
      endDrag();
      return;
    }
    // The escape. A press that fires at 240ms sometimes catches a reader who
    // was only ever starting a scroll, and the way that reader tells us so is
    // by leaving immediately AND FAST. Take the selection back off them and
    // scroll instead of dragging a selection across the passage they wanted to
    // scroll past.
    //
    // Both halves are required, and both are measured honestly — from where the
    // press fired, on the move's own clock, against a real speed. See
    // PRESS_ESCAPE_PX for what each of those three was doing wrong and which
    // half of the report it was producing.
    const sinceFired = escapeAt - pressFiredAt;
    const travelled = Math.hypot(touch.clientX - pressFiredX, touch.clientY - pressFiredY);
    // Between the last two moves when there are two, and from the press itself
    // when there are not.
    //
    // The second half is not a fallback, it is the main case: the gesture the
    // escape exists for is a HESITATION followed by a departure, and a finger
    // that hesitated sent no touchmoves to compare against. Measuring from the
    // press is exact there rather than approximate — the finger was by
    // definition within PRESS_SLOP_PX of pressFired when the press resolved, so
    // the distance it has covered since divided by the time since is its speed.
    const from = lastMoveAt >= pressFiredAt
      ? { x: lastMoveX, y: lastMoveY, at: lastMoveAt }
      : { x: pressFiredX, y: pressFiredY, at: pressFiredAt };
    const elapsed = escapeAt - from.at;
    const speed = elapsed > 0
      ? Math.hypot(touch.clientX - from.x, touch.clientY - from.y) / elapsed
      : 0;
    lastMoveX = touch.clientX;
    lastMoveY = touch.clientY;
    lastMoveAt = escapeAt;
    if (sinceFired < PRESS_ESCAPE_MS
        && travelled > PRESS_ESCAPE_PX
        && speed > PRESS_ESCAPE_SPEED_PX_PER_MS) {
      beginEscapeScroll(event.currentTarget, touch);
      event.preventDefault();
      return;
    }
    event.preventDefault();
    // No offset on this one, deliberately. The finger that pressed is already
    // ON the word it selected, and moving the caret away from it would make
    // press-and-slide feel like it had missed. Offsetting is for a handle, which
    // is grabbed by a bulb that hangs below the line.
    framePoint = { x: touch.clientX, y: touch.clientY };
    scheduleFrame(true);
    updateEdgeScroll(touch.clientX, touch.clientY, escapeAt);
    return;
  }
  if (!pressActive && !dismissPending) return;
  // The browser has started scrolling and we never asked it not to, so this
  // finger is on a moving page. A press that fired now would be a buzz over
  // text that is sliding away, and its touchend could not stop the
  // compatibility mousedown collapsing whatever it selected. Give it up while
  // giving up costs nothing — the scroll is already native, with its fling
  // intact, which is exactly what the reader asked for.
  if (gestureStolen) {
    dismissPending = false;
    cancelPress();
    return;
  }
  const touch = event.touches[0];
  if (!touch) { cancelPress(); return; }
  // Recorded for the whole gesture, not only after the press fires, so the
  // FIRST move after the buzz already has a previous point to read a speed
  // against. Without it that move is unmeasurable and the escape has to let it
  // through — which is the right default, but it costs a frame of recognition
  // on a genuine flick, and a flick is over in about three.
  lastMoveX = touch.clientX;
  lastMoveY = touch.clientY;
  lastMoveAt = escapeAt;
  const travelled = Math.hypot(touch.clientX - pressOriginX, touch.clientY - pressOriginY);
  if (travelled > PRESS_SLOP_PX) {
    // Moving is scrolling, and scrolling is not a dismissal.
    dismissPending = false;
    cancelPress();
    return;
  }
  // Inside the slop the press stands, but the finger has still drifted — aim
  // where it is now rather than where it landed, or a thumb that rolls a few
  // pixels selects the word next door.
  pressX = touch.clientX;
  pressY = touch.clientY;
}

// preventDefault here is not optional, and it is not about scrolling.
//
// A touchend that is allowed its default action synthesises the compatibility
// mouse sequence — mousedown, mouseup, click — and Chrome answers a mousedown on
// the page by COLLAPSING the selection to a caret at that point. Natively that
// never happens, because the browser owns both halves and knows the press it
// just resolved was a selection. Here the two halves are ours and the browser's,
// so lifting the finger at the end of a press-drag threw the selection away
// roughly 50ms after making it: the pill flashed up and vanished, and the note
// looked like the press had done nothing at all.
//
// Only for a gesture that actually became a selection. An ordinary tap keeps its
// mouse events — every link, cloze, image control and highlight in a note is
// reached by one.
function onRootTouchEnd(event) {
  // A rescued scroll ends here, and it keeps the preventDefault a drag gets:
  // the finger travelled across the text, so the compatibility click that a
  // plain touchend would synthesise would land on whatever it finished over.
  if (escapeScroll) {
    escapeScroll = null;
    cancelPress();
    event.preventDefault();
    dismissPending = false;
    releaseSurface();
    return;
  }
  const wasSelecting = pressDragging || Boolean(draggingHandle);
  const dismiss = dismissPending && !wasSelecting;
  dismissPending = false;
  cancelPress();
  if (pressDragging) endDrag();
  // A drag that ended early because the browser took the gesture (see
  // gestureStolen) has already run endDrag, so pressDragging is false by now —
  // but the selection it left standing is still worth defending against the
  // compatibility mousedown this touchend cannot cancel. That is the whole
  // reason the window exists.
  if (wasSelecting || gestureStolen) {
    event.preventDefault();
    if (liveRange) selectionDefendedUntil = performance.now() + SELECTION_DEFEND_MS;
  }
  // The gesture that landed outside the selection turned out to be a tap. THIS
  // is the dismissal — see onRootTouchStart for why it is not the touchstart.
  // A cancelled touch (the scroller taking the gesture over) is a scroll by
  // definition and never gets here with the flag still set, because the move
  // past the slop cleared it.
  if (dismiss && event.type !== "touchcancel") clearTouchSelection();
  // The backstop. cancelPress(), endDrag() and clearTouchSelection() each drop
  // the flag on their own paths, but every touch ends here and a flag left set
  // would switch the viewport renderer's promotion off for the rest of the
  // session. One unconditional release is cheaper than proving the other three
  // cover every route.
  releaseSurface();
}

// Hand the reading surface back to whatever stood down for the gesture, and pay
// back what the viewport renderer queued while it was standing down.
// src/core/gesture.js runs the release listeners; this call is the one that
// makes the flag false.
function releaseSurface() {
  setTouchGestureHoldsSurface(false);
}

// ── Arming and disarming ───────────────────────────────────────────────────

const boundRoots = new Set();

function bindRoot(root) {
  if (boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener("touchstart", onRootTouchStart, { passive: true });
  root.addEventListener("touchmove", onRootTouchMove, { passive: false });
  // Non-passive, because the whole job of the touchend handler is a
  // preventDefault — see the comment above it.
  root.addEventListener("touchend", onRootTouchEnd, { passive: false });
  root.addEventListener("touchcancel", onRootTouchEnd, { passive: false });
  // A scroll is three things at once here: the press timer's cancellation
  // (Android's own signal, and exact where the 10px slop test is a guess), the
  // reason to take the handles off the glass while the text is moving, and the
  // reason to put them back when it stops.
  root.addEventListener("scroll", onRootScroll, { passive: true });
  // Long press over a link or an image would otherwise open Chrome's own
  // context menu on top of the selection we just made. A link is still followed
  // by an ordinary tap; this only refuses the menu.
  root.addEventListener("contextmenu", (event) => {
    if (!canTouchSelect()) return;
    event.preventDefault();
  });
}

function arm() {
  if (armed) return;
  armed = true;
  // Tell selection.js the gesture has an owner. Everything it inferred about a
  // native handle from a burst of selectionchange events is now a fact somebody
  // reports, and running both at once is a race — see setTouchSelectionArmed.
  setTouchSelectionArmed(true);
  document.body.classList.add("has-touch-select");
  touchSelectionRoots().forEach(bindRoot);
  buildOverlay();
}

function disarm() {
  if (!armed) return;
  armed = false;
  setTouchSelectionArmed(false);
  clearTouchSelection();
  document.body.classList.remove("has-touch-select");
  document.body.classList.remove("is-touch-scrolling");
  destroyOverlay();
  // Leaving a registered highlight behind would paint nothing (its range is
  // gone) but would still be visible to anything enumerating CSS.highlights, and
  // the desktop check asserts it is absent.
  try { window.CSS?.highlights?.delete(HIGHLIGHT_NAME); } catch (_) { /* never registered */ }
  touchHighlight = null;
}

function syncGate() {
  if (canTouchSelect()) arm();
  else disarm();
}

export function initTouchSelection() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  syncGate();
  // Live, so plugging a mouse into a tablet — or toggling devtools device
  // emulation — hands native selection straight back rather than leaving the
  // reader on a surface where user-select is off and nothing has replaced it.
  touchSelectMedia?.addEventListener?.("change", syncGate);

  // Anything that drops the document selection drops ours with it. Every pill
  // action ends in removeAllRanges(), so this is the one listener that keeps the
  // painted highlight and the app's own idea of the selection in step, instead
  // of a clearTouchSelection() call bolted onto each of them.
  document.addEventListener("selectionchange", () => {
    if (!liveRange || !liveRoot) return;
    const selection = window.getSelection();
    const lost = !selection || !selection.rangeCount || selection.isCollapsed
      || !liveRoot.contains(selection.anchorNode) || !liveRoot.contains(selection.focusNode);
    if (!lost) return;
    // Our own Range still points at connected nodes inside the surface, and a
    // gesture is either in flight or has just finished — so this is not the
    // reader dismissing anything. It is one of the two collapses described
    // above SELECTION_DEFEND_MS, and the mirror is the copy that went wrong,
    // not the Range. Push the Range back into it.
    if (defendSelection(selection)) return;
    clearTouchSelection({ keepDocumentSelection: true });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && liveRange) clearTouchSelection();
  });

  // ── A press that lands outside the reading surface entirely ───────────────
  //
  // "Sometimes it gets involved and doesn't go away even if I click on
  // somewhere else." It did not, and it could not: every touch listener above
  // is bound to touchSelectionRoots() — the note, the two card faces and the
  // document — so `dismissPending` is only ever set for a press INSIDE one of
  // them. A press on the notes header, the tab row, the appbar, the margin
  // beside the column, the side-by-side pane or the reading rail set nothing at
  // all.
  //
  // And nothing else was going to clear it either. The reading surfaces carry
  // `user-select: none` while this controller is armed (styles/32-touch-select
  // .css), so the browser never collapses the selection on its own; the pill is
  // pinned to the bottom of the screen on a phone and
  // hideNotesSelectionButtonUnlessPinned deliberately declines to hide it on a
  // scroll. So the bar stayed, over the words, with no way out but Escape on a
  // device with no keyboard.
  //
  // Capture, and pointerdown rather than click, for the same two reasons the
  // mark menu's own outside-press listener gives (src/notes/mark-menu.js): the
  // note's handlers stopPropagation in places, and a press is the moment the
  // reader has decided, not the release.
  //
  // What it must NOT eat:
  //
  //   • a press inside the surface — the touch handlers own that, and they can
  //     tell a tap from a scroll, which is the distinction this listener has no
  //     way to make and the reason the dismissal was moved to the touchend in
  //     the first place (see onRootTouchStart);
  //   • a press on the bar, or on a menu hanging off it, or on a drag handle:
  //     that is the reader USING the selection, not leaving it;
  //   • a press on the mark menu, which can be open over a highlight while a
  //     selection stands somewhere else;
  //   • and — the one that is not obvious — a press on ANY [data-render-action]
  //     button. Those are the notes header's ⋯ rows: make a flashcard, make a
  //     cloze, pin to Quick Notes. They sit OUTSIDE every reading root, they
  //     act on the live selection, and they are driven by a pointerdown handler
  //     of their own (src/main.js). This listener is capture-phase, so without
  //     this line it would run first and throw the selection away a beat before
  //     the button that wanted it.
  document.addEventListener("pointerdown", (event) => {
    if (!liveRange) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (touchSelectionRoots().some((root) => root.contains(target))) return;
    if (target.closest("[data-render-action], [data-render-color], .selection-float, .selection-float-menu, .render-color-menu, .render-text-style-menu, .mark-menu, .touch-select-handle")) return;
    clearTouchSelection();
    // ...and the bar with it, explicitly. clearTouchSelection() ends in
    // removeAllRanges(), and the pill's own hide rides on the selectionchange
    // that fires — but removeAllRanges() on a selection the browser already
    // considers empty fires nothing, which is exactly the state a bar left
    // standing after an action is in. One direct call costs a few property
    // reads (hideNotesSelectionButton returns early when there is nothing to
    // do) and closes that gap for good.
    hideNotesSelectionButton();
  }, { capture: true, passive: true });

  window.addEventListener("resize", scheduleHandleUpdate, { passive: true });
  // The layout viewport is not the visual one on a phone. Android's URL bar
  // collapsing on a scroll, and the software keyboard opening, both move the
  // origin of a `position: fixed` layer without firing a window resize — so the
  // handles quietly drifted off their boundaries and stayed there.
  window.visualViewport?.addEventListener?.("resize", scheduleHandleUpdate, { passive: true });
  window.visualViewport?.addEventListener?.("scroll", scheduleHandleUpdate, { passive: true });
}
