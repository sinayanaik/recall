// The teleprompter: Notes that scroll by themselves, at a speed the reader
// sets, under a band that marks the line to read.
//
// "Reading articles in the notes I have imported, it is very hard to scroll" —
// so the text comes to the reader instead. Touching it stops it at once — the
// teleprompter stays, band and all, and only the scrolling stops — and the text
// works exactly as in Notes: long-press to select, highlight, open a
// highlight's menu, make a card. ▶ Resume (or Space) carries on from wherever
// the text is by then; a setting can make it carry on by itself once the
// reader has been still for a few seconds.
//
// ── What a session changes, and gives back ─────────────────────────────────
//
//   • The type. Size, spacing, width and font are written INLINE on #notesView
//     as the same four --notes-* variables the Style panel writes on :root, so
//     a style change made while it runs cannot undo them and leaving takes
//     nothing but removing them. They stay while paused, by the reader's
//     choice: words that jump under a finger reaching for them cannot be
//     selected. So do the band and the dimming, which step back only while a
//     selection or a highlight's menu is up (the bar's `tucked`).
//   • Paging. A columned note has nowhere to scroll down to, so paged mode is
//     suspended (setNotesPagedSuspended) and comes back on leaving, turned to
//     the page holding the line the reader was on.
//   • Focus mode, if the setting asks and it was not on already.
//   • A lead-in and a run-out (::before and ::after, styles/83-teleprompter.css)
//     so the first line can start in the band and the last can reach it.
//
// Every one of those moves the text, and each is applied holding the reader's
// line where it is: a block and how far down it, measured before and put back
// after (keepLineAt).
//
// ── The loop ───────────────────────────────────────────────────────────────
//
// The shape of touch-selection's edge scroll (startEdgeScroll): one frame, one
// scrollTop write, each announced with markProgrammaticNotesScroll so the four
// scroll listeners on #notesView do not run their measuring on every frame. The
// position is a float kept here, because at 12px a second a frame moves a fifth
// of a pixel and `scrollTop += 0.2` rounds to standing still. Anything else that
// moves the scroller — scroll anchoring as blocks above lay out, a repaint, a
// rotation's hold — is followed rather than fought: a scrollTop that is not the
// one this wrote last is where the loop carries on from.
//
// scrollTop only holds whole CSS pixels (Chrome rounds 10.2 to 10 at any
// device pixel ratio), so a note written there alone stood still for four or
// five frames and then jumped a pixel — three device pixels on a phone — which
// is the judder "stuttering sometimes" was. The part of a pixel it cannot hold
// is a transform on the scroller instead (placeSubPixel): written on the
// element itself, never as a variable the whole note would inherit, so it is
// the compositor's alone — no style, layout or paint of the text. It is there
// only while the frames run; a paused note has none.
//
// Speed is in words a minute, which is how reading speed is measured everywhere
// else in the app (src/stats/reading-speed.js), and the default IS the reader's
// measured speed once there is one. It is turned into pixels from how densely
// the text AT THE BAND packs words: the line just read and the fifteen coming,
// counted in the teleprompter's own lines so a phone and a monitor measure the
// same stretch of text — re-measured every 750ms, never per frame, and
// smoothed. A picture or a code block has no words and is left out, so it
// passes at the pace of the text around it. It used to be measured over the
// whole screen, from its top edge down, and that made the speed the screen's:
// a heading read a minute ago stayed in the sample until it scrolled off the
// top, and a note of headings and lists took more or less of the screen by its
// size — the same 600 wpm read 554 on a phone, 540 on a tablet and 601 on a
// desktop (tools/teleprompter-check.mjs). Time a long frame on a slow phone did
// not move the text by, the word clock makes up (src/notes/teleprompter-pace.js).
//
// ── Interrupting it ────────────────────────────────────────────────────────
//
// A press, a touch or a wheel anywhere but its own controls stops it IN THE
// SAME TICK, from capture-phase listeners on the document. That is not a nicety.
// src/notes/touch-selection.js cancels a long-press if the content under the
// finger moves more than 10px while it waits 240ms to decide, so a teleprompter
// that eased to a stop over a quarter of a second would turn every first
// long-press into a scroll — "I have to press again and again".

import { el, isDisplayed } from "../core/dom.js?v=__BUILD__";
import { readerTouchDown, setNotesAutoScrolling, touchGestureHoldsSurface } from "../core/gesture.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { NOTES_CHUNK_CLASS, NOTES_CHUNK_PENDING_CLASS, withChunkRendered } from "../render/block-cache.js?v=__BUILD__";
import { formatDuration } from "../stats/combine.js?v=__BUILD__";
import { lastExactNotesReading, liveNotesWordsLeft, readingTimeLeft } from "../stats/reading-progress.js?v=__BUILD__";
import { readSpeedModel, speedFor, speedMeasured } from "../stats/reading-speed.js?v=__BUILD__";
import { isAdjustHandlesOpen } from "../ui/adjust-handles.js?v=__BUILD__";
import { isFocusModeActive, setFocusMode } from "../ui/chrome.js?v=__BUILD__";
import { anyModalOpen } from "../ui/overlays.js?v=__BUILD__";
import {
  WHEEL_LINES, glideScrollTo, isNotchedWheel, lineMiddlesBetween, pendingGlidePx, stopGlide, wheelNotches
} from "./band-steps.js?v=__BUILD__";
import { isHighlightNoteEditorOpen } from "./highlight-note-editor.js?v=__BUILD__";
import { isMarkMenuOpen } from "./mark-menu.js?v=__BUILD__";
import { isNotesHeadMoreOpen } from "./notes-head-overflow.js?v=__BUILD__";
import { isNotesEditing, markProgrammaticNotesScroll, onDeckSwap } from "./notes-view.js?v=__BUILD__";
import {
  firstVisibleNotesBlock, isNotesPaged, notesSelectionHoldsText, revealInPagedNotes, setNotesPagedSuspended
} from "./paged-view.js?v=__BUILD__";
import { flushReadingPositionSave } from "./reading-position.js?v=__BUILD__";
import {
  captureCurrentReadingAnchor, currentDeckKey, currentReadingAnchor, currentReadingAnchorDeckKey, deferNotesResume,
  isReflowHolding, isResumeLanding, notesBlockAtReadingLineGeometric, notesReadingLineOffset, scheduleReadingAnchorCapture
} from "./scroll-anchor.js?v=__BUILD__";
import { isSelectionAdjusting, selectionGestureIsLive } from "./selection.js?v=__BUILD__";
import {
  TELEPROMPTER_AUTO_RESUMES, TELEPROMPTER_COUNTDOWNS, TELEPROMPTER_FONTS, TELEPROMPTER_RANGES, TELEPROMPTER_SCROLLS,
  closeTeleprompterSheet, ensureTeleprompterPanel, isTeleprompterSheetOpen, paintTeleprompterPanel,
  placeTeleprompterBand, removeTeleprompterPanel, teleprompterPanelContains, toggleTeleprompterSheet, wakeTeleprompterBar
} from "./teleprompter-panel.js?v=__BUILD__";
import {
  FRAME_COUNT_MAX_S, FRAME_MOVE_MAX_S, measuredClockWpm, newWordClock, paceFactor, rebaseWordClock, wordsDone, wordsDueFor
} from "./teleprompter-pace.js?v=__BUILD__";
import { touchSelectionRange } from "./touch-selection.js?v=__BUILD__";

// ── Settings ────────────────────────────────────────────────────────────────
//
// Per device, like the progress row: a phone held at arm's length and a desktop
// monitor want different sizes and different speeds. In a library backup
// (src/backup/archive-format.js), never in a share.
export const TELEPROMPTER_SETTINGS_KEY = "recall:teleprompter-v1";

// wpm and fontSize 0 mean "not chosen yet": the speed is then the reader's
// measured one, and the size a quarter up on whatever Notes is set to — so both
// keep following those until the reader picks a number of their own.
const TELEPROMPTER_DEFAULTS = {
  wpm: 0,
  fontSize: 0,
  lineHeight: 1.7,
  width: 100,
  font: "notes",
  bandPos: 35,
  bandSize: 2,
  dim: 45,
  band: true,
  countdown: 3,
  autoResume: 0,
  focus: true,
  wake: true,
  scroll: "auto"
};

const TELEPROMPTER_FALLBACK_WPM = 200;

const TELEPROMPTER_FONT_STACKS = {
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
};

// The four variables the Style panel writes on :root, overridden on the note.
const TELEPROMPTER_TYPE_VARS = ["--notes-font-size", "--notes-line-height", "--notes-max-width", "--notes-font-family"];

// How long the text takes to come up to speed, and to stop when ❚❚ is pressed.
// A press on the text stops it at once instead — see the header.
const RAMP_IN_S = 0.5;
const RAMP_OUT_S = 0.25;

const DENSITY_MS = 750;
const WATCH_MS = 250;

// How quickly the speed follows a new measure of the density: a time constant,
// so a page of lists after a page of prose changes the speed over a second or
// two instead of in one step every 750ms.
const DENSITY_EASE_S = 1.2;

let settingsCache = null;

// Any value inside the setting's floor and ceiling — not the slider's range,
// which is only the comfortable part of it (see TELEPROMPTER_RANGES). The PDF's
// teleprompter (src/documents/pdf-teleprompter.js) keeps its numbers the same way.
export function clampToRange(key, value) {
  const range = TELEPROMPTER_RANGES[key];
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const scale = 10 ** range.decimals;
  return Math.round(Math.min(range.ceiling, Math.max(range.floor, number)) * scale) / scale;
}

function normaliseTeleprompterSettings(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const out = { ...TELEPROMPTER_DEFAULTS };
  Object.keys(TELEPROMPTER_RANGES).forEach((key) => {
    if (!(key in input)) return;
    // The two that may be 0 for "follow the default".
    if ((key === "wpm" || key === "fontSize") && Number(input[key]) === 0) return;
    const value = clampToRange(key, input[key]);
    if (value !== null) out[key] = value;
  });
  if (TELEPROMPTER_FONTS.some(([value]) => value === input.font)) out.font = input.font;
  if (TELEPROMPTER_COUNTDOWNS.includes(Number(input.countdown))) out.countdown = Number(input.countdown);
  if (TELEPROMPTER_AUTO_RESUMES.includes(Number(input.autoResume))) out.autoResume = Number(input.autoResume);
  if (TELEPROMPTER_SCROLLS.some(([value]) => value === input.scroll)) out.scroll = input.scroll;
  ["band", "focus", "wake"].forEach((key) => {
    if (typeof input[key] === "boolean") out[key] = input[key];
  });
  return out;
}

export function readTeleprompterSettings() {
  if (!settingsCache) {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(TELEPROMPTER_SETTINGS_KEY) || "null"); } catch { raw = null; }
    settingsCache = normaliseTeleprompterSettings(raw);
  }
  return { ...settingsCache };
}

function writeTeleprompterSettings(next) {
  settingsCache = normaliseTeleprompterSettings(next);
  try { localStorage.setItem(TELEPROMPTER_SETTINGS_KEY, JSON.stringify(settingsCache)); } catch { /* this session only */ }
  return { ...settingsCache };
}

// The reader's own measured speed, rounded to the slider's step — or null
// until this device has watched them read long enough to trust it. Words a
// minute are measured on notes only (a PDF's speed is kept in pages), so the
// PDF's teleprompter starts from this too.
export function measuredTeleprompterWpm() {
  const model = readSpeedModel();
  if (!speedMeasured(model, "notes")) return null;
  const msPerWord = speedFor(model, "notes");
  if (!(msPerWord > 0)) return null;
  return clampToRange("wpm", Math.round(60000 / msPerWord / 10) * 10);
}

// ── The session ─────────────────────────────────────────────────────────────

// null when there is none. Phases: "countdown" → "playing" ⇄ "paused", and
// "ended" at the foot of the note; or "manual" for as long as the reader has
// chosen to scroll by hand — the band, the dimming and the type, and no loop.
let teleprompterSession = null;

// The ⋯ row and the rail's copy of it are painted from here; the rail is told
// through a hook because it imports this module (src/main.js registers it).
let teleprompterChangedHook = null;

export function setTeleprompterChangedHook(fn) {
  teleprompterChangedHook = typeof fn === "function" ? fn : null;
}

export function teleprompterActive() {
  return Boolean(teleprompterSession);
}

// On screen as well as open. A session survives a trip to Cards or Home —
// paused, so the reader comes back to their line and ▶ — and Escape or Back
// pressed over Cards must not be spent leaving something nobody can see.
export function teleprompterOnScreen() {
  return Boolean(teleprompterSession) && state.viewMode === "notes" && isDisplayed(el.notesView);
}

// For tools/teleprompter-check.mjs, and for nothing that changes behaviour.
export function teleprompterSnapshot() {
  if (!teleprompterSession) return null;
  return {
    phase: teleprompterSession.phase,
    wpm: teleprompterSession.wpm,
    fontSize: teleprompterSession.fontSize,
    pauseReason: teleprompterSession.pauseReason,
    pxPerSecond: teleprompterPxPerSecond(),
    wordsPerPx: teleprompterSession.wordsPerPx,
    pace: paceFactor(teleprompterSession.clock, teleprompterSession.wpm),
    wordsDue: teleprompterSession.clock.due,
    wordsDone: teleprompterSession.clock.done,
    measuredWpm: measuredClockWpm(teleprompterSession.clock),
    subPixel: teleprompterSession.subPixel,
    wordsPerMarkdownWord: teleprompterSession.lambda,
    leftMs: teleprompterTimeLeftMs(),
    settings: { ...teleprompterSession.settings }
  };
}

// One MediaQueryList for the session's life rather than a new one per frame:
// `.matches` stays live on the object.
let reducedMotionQuery = null;

function reducedMotion() {
  if (!reducedMotionQuery && typeof matchMedia === "function") reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  return Boolean(reducedMotionQuery?.matches);
}

// ── Where the reader has got to, written down now ───────────────────────────
//
// Every frame of the teleprompter is the app's own scroll, so the scroll
// listener in main.js saves nothing while it plays. scheduleReadingAnchorCapture
// alone was not enough to make up for that: it waits 150ms and an idle
// callback, and by then a press on Home, My Files or another tab has hidden
// the note — the capture finds nothing on screen and gives up, and twenty
// minutes of reading reopen where the session began. So the place is taken
// synchronously, in the press that pauses, while the note is still displayed;
// `flush` also writes it straight to the store, for the moments the app may
// not get another chance (backgrounded, leaving).
const PLAY_CAPTURE_MS = 5000;

function saveTeleprompterPlace({ flush = false } = {}) {
  if (!teleprompterSession || state.viewMode !== "notes" || !isDisplayed(el.notesView)) return;
  if (currentDeckKey() !== teleprompterSession.deckKey) return;
  captureCurrentReadingAnchor(teleprompterSession.deckKey);
  teleprompterSession.capturedAt = performance.now();
  if (flush) flushReadingPositionSave();
}

// The every-few-seconds copy taken while it plays, which nothing is waiting
// on: a capture is a hit-test, a Range.toString and a snippet search (see
// READING_ANCHOR_IDLE_MS in src/notes/scroll-anchor.js), and taken inside the
// watch it was a dropped frame every five seconds. In the browser's idle time
// between frames instead. The captures that matter — the press that pauses,
// the app going away, the end — stay synchronous.
function savePlaceWhenIdle() {
  const owner = teleprompterSession;
  if (!owner || owner.idleSave) return;
  owner.capturedAt = performance.now();
  owner.idleSave = true;
  const run = () => {
    owner.idleSave = false;
    if (teleprompterSession === owner && owner.phase === "playing") saveTeleprompterPlace();
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 0);
}

// ── Geometry ────────────────────────────────────────────────────────────────

function teleprompterLineHeight(view) {
  const style = getComputedStyle(view);
  const line = parseFloat(style.lineHeight);
  return Number.isFinite(line) && line > 0 ? line : (parseFloat(style.fontSize) || 16) * 1.5;
}

// The band, in px inside the note's scrollport: as many lines tall as the reader
// chose (never taller than the scrollport), centred on the height they chose.
function bandGeometry(view) {
  const line = teleprompterLineHeight(view);
  const height = view.clientHeight;
  const bandHeight = Math.round(Math.min(height, line * teleprompterSession.settings.bandSize));
  const centre = height * (teleprompterSession.settings.bandPos / 100);
  const bandTop = Math.round(Math.max(0, Math.min(height - bandHeight, centre - bandHeight / 2)));
  return { line, height, bandTop, bandHeight, bandLine: bandTop + bandHeight / 2 };
}

function bandLineY(view) {
  return view.getBoundingClientRect().top + bandGeometry(view).bandLine;
}

function readingLineY(view) {
  return view.getBoundingClientRect().top + notesReadingLineOffset(view.clientHeight);
}

// Where a viewport line falls in the note: the block under it and how far down
// that block, which survives a re-wrap where a pixel offset does not.
function measureLineAnchor(view, y) {
  if (isNotesPaged()) {
    const block = firstVisibleNotesBlock();
    return block ? { block, fraction: 0 } : null;
  }
  const block = notesBlockAtReadingLineGeometric(y);
  if (!block) return null;
  const rect = withChunkRendered(block, view, () => block.getBoundingClientRect());
  return { block, fraction: rect.height ? Math.max(0, Math.min(1, (y - rect.top) / rect.height)) : 0 };
}

function anchorResidual(view, anchor, y) {
  if (!anchor?.block?.isConnected || !view.contains(anchor.block)) return null;
  const rect = withChunkRendered(anchor.block, view, () => anchor.block.getBoundingClientRect());
  return rect.top + anchor.fraction * rect.height - y;
}

// Puts the anchor back on the line `lineY()` names: now, and again on each of
// the next two frames, as the blocks around it finish laying out at the new
// type. `done` runs after the last.
function keepLineAt(view, anchor, lineY, done = null) {
  const aim = () => {
    const residual = anchor ? anchorResidual(view, anchor, lineY()) : null;
    if (residual != null && Math.abs(residual) > 0.5) {
      markProgrammaticNotesScroll();
      view.scrollTop = Math.max(0, view.scrollTop + residual);
    }
  };
  aim();
  requestAnimationFrame(() => {
    aim();
    requestAnimationFrame(() => {
      aim();
      done?.();
    });
  });
}

// A change that moves the text — the type, the band's height or size — made with the
// line on the band held where it is. The loop stands still meanwhile.
function holdBandPlace(change) {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  const anchor = isDisplayed(view) ? measureLineAnchor(view, bandLineY(view)) : null;
  teleprompterSession.holding += 1;
  setNotesAutoScrolling(false);
  change();
  const owner = teleprompterSession;
  keepLineAt(view, anchor, () => bandLineY(view), () => {
    if (teleprompterSession !== owner) return;
    teleprompterSession.holding = Math.max(0, teleprompterSession.holding - 1);
    resyncPosition();
  });
}

function resyncPosition() {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  teleprompterSession.pos = view.scrollTop;
  teleprompterSession.lastWritten = view.scrollTop;
  // Carrying on from wherever the view is: nothing before this is owed, and
  // the words counted since are not the words between here and there.
  rebaseWordClock(teleprompterSession.clock);
  teleprompterSession.moves += 1;
}

// ── The type, the runway and the band ───────────────────────────────────────

function applyTeleprompterType(view) {
  const { settings } = teleprompterSession;
  forgetTimeLeftLearning();
  view.style.setProperty("--notes-font-size", `${teleprompterSession.fontSize}px`);
  view.style.setProperty("--notes-line-height", String(settings.lineHeight));
  view.style.setProperty("--notes-max-width", `${settings.width}%`);
  if (TELEPROMPTER_FONT_STACKS[settings.font]) view.style.setProperty("--notes-font-family", TELEPROMPTER_FONT_STACKS[settings.font]);
  else view.style.removeProperty("--notes-font-family");
  // Type of a different size packs words differently; measure it afresh.
  teleprompterSession.wordsPerPx = 0;
  teleprompterSession.densityTarget = 0;
  teleprompterSession.screenWordsPerPx = 0;
  rebaseWordClock(teleprompterSession.clock, { measure: true });
}

function clearTeleprompterType(view) {
  TELEPROMPTER_TYPE_VARS.forEach((name) => view.style.removeProperty(name));
  view.style.removeProperty("--tp-lead");
  view.style.removeProperty("--tp-runout");
}

// The lead-in and run-out, sized so the note's first line can sit in the band
// with the scroller at the top, and its last line can be scrolled up to it.
// `compensate`: a resize changed the lead-in under a reader who is part-way
// down, so scrollTop takes the same change and the text does not move.
function sizeTeleprompterRunway(view, geometry, { compensate = false } = {}) {
  const style = getComputedStyle(view);
  const padTop = parseFloat(style.paddingTop) || 0;
  const padBottom = parseFloat(style.paddingBottom) || 0;
  const lead = Math.max(0, Math.round(geometry.bandTop - padTop));
  const runout = Math.max(0, Math.round(geometry.height - geometry.bandTop - geometry.bandHeight - padBottom));
  const delta = lead - (teleprompterSession.lead || 0);
  view.style.setProperty("--tp-lead", `${lead}px`);
  view.style.setProperty("--tp-runout", `${runout}px`);
  teleprompterSession.lead = lead;
  teleprompterSession.textTop = padTop + lead;
  if (compensate && delta && view.scrollTop > 0) {
    markProgrammaticNotesScroll();
    view.scrollTop += delta;
    resyncPosition();
  }
}

function placeBand(view, geometry = bandGeometry(view)) {
  const { settings } = teleprompterSession;
  placeTeleprompterBand({
    top: view.offsetTop,
    left: view.offsetLeft,
    width: view.clientWidth,
    height: view.clientHeight,
    bandTop: geometry.bandTop,
    bandHeight: geometry.bandHeight,
    dim: settings.dim,
    showBand: settings.band
  });
}

function relayoutTeleprompter({ compensate = false } = {}) {
  const view = el.notesView;
  if (!teleprompterSession || !view || !view.clientHeight) return;
  const geometry = bandGeometry(view);
  sizeTeleprompterRunway(view, geometry, { compensate });
  placeBand(view, geometry);
  // How far below Notes' own reading line the band sits: the place a capture
  // reads off is that line, and the time left is counted from the band.
  teleprompterSession.readingLine = notesReadingLineOffset(geometry.height);
  teleprompterSession.lineGap = geometry.bandLine - teleprompterSession.readingLine;
}

// ── Words a minute into pixels a second ─────────────────────────────────────

const TELEPROMPTER_TEXT_BLOCKS = "p, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6";

// Each block's words, counted once: the measure below runs every 750ms over
// the same blocks, and counting meant a regex over each one's text every time.
const blockWordCounts = new WeakMap();

// Text that is in the block and not read: KaTeX's MathML copy of a formula
// (textContent has every formula twice), a fold's twisty, anything hidden.
const UNREAD_TEXT = ".katex-mathml, [aria-hidden='true'], [hidden]";

function readTextOf(block) {
  if (!block.querySelector(UNREAD_TEXT)) return block.textContent;
  let text = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return node.matches(UNREAD_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    }
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.data;
  return text;
}

function blockWords(block) {
  let words = blockWordCounts.get(block);
  if (words === undefined) {
    words = (readTextOf(block).match(/\S+/g) || []).length;
    blockWordCounts.set(block, words);
  }
  return words;
}

// The block after this one in reading order, across a chunk's edge.
function nextReadingBlock(node, view) {
  if (node.nextElementSibling) return node.nextElementSibling;
  const parent = node.parentElement;
  if (!parent || parent === view || !parent.classList.contains(NOTES_CHUNK_CLASS)) return null;
  let chunk = parent.nextElementSibling;
  while (chunk && !chunk.firstElementChild) chunk = chunk.nextElementSibling;
  return chunk?.firstElementChild || null;
}

// The stretch the density is measured over, in the teleprompter's own lines:
// the line just read, and more of what is coming to the band. Not more behind
// it: at a slow speed on a wide screen three lines take ten seconds to pass,
// and a heading read that long ago went on making the prose after it race.
// Fifteen ahead (or to the foot of the screen, if that is nearer) so a list or
// a heading changes the speed over a few lines rather than at once; with
// fewer, the words counted ran ahead through a list and behind after it, by
// enough to move the time left a tenth.
const DENSITY_LINES_BEFORE = 1;
const DENSITY_LINES_AFTER = 15;

// Words per pixel of the text at the band, with each block's share of the gap
// to the next counted as its own, as the progress row's measure does
// (visibleWordsPerPx in src/stats/reading-progress.js). A block only partly in
// the window counts for the part that is, words and height alike.
//
// A picture, a table or a code block has height and no words to read at a
// pace, and passes at the pace of the text around it: its pixels are counted
// at the density of the text on the screen. Left out of the window instead,
// it took the pace of whatever little text shared the window with it — a
// list of links just before a table, say — and raced.
//
// The screen's own density is kept too, for that and for the time left while
// it has nothing better to go by (see rawTimeLeftMs): a guess at the note's
// words a pixel that must hold steady for the length of a screen, which the
// band's does not.
function measureTeleprompterDensity(view) {
  const box = view.getBoundingClientRect();
  const geometry = bandGeometry(view);
  const line = geometry.line;
  const bandY = box.top + geometry.bandLine;
  const bottom = box.top + view.clientHeight;
  // Never past the scrollport: a block out of sight may be one
  // `content-visibility` has not laid out, with a height that is a guess.
  const from = Math.max(box.top + 1, bandY - DENSITY_LINES_BEFORE * line);
  const to = Math.min(bottom, bandY + DENSITY_LINES_AFTER * line);
  let block = notesBlockAtReadingLineGeometric(box.top + 1);
  let words = 0;
  let height = 0;
  let wordless = 0;
  let screenWords = 0;
  let screenHeight = 0;
  let width = 0;
  for (let i = 0; block && i < 60; i += 1) {
    const rect = block.getBoundingClientRect();
    if (rect.top > bottom) break;
    const next = nextReadingBlock(block, view);
    if (rect.height > 0) {
      const slotBottom = next ? Math.max(rect.bottom, next.getBoundingClientRect().top) : rect.bottom;
      const slot = slotBottom - rect.top;
      const inside = Math.max(0, Math.min(slotBottom, to) - Math.max(rect.top, from));
      const text = block.matches(TELEPROMPTER_TEXT_BLOCKS);
      if (!text) {
        wordless += inside;
      } else if (slot > 0) {
        screenWords += blockWords(block);
        screenHeight += slot;
        if (inside > 0) {
          words += (blockWords(block) * inside) / slot;
          height += inside;
          width = width || block.clientWidth;
        }
      }
    }
    block = next;
  }
  // What the type predicts: a word is about six characters with its space, a
  // character about half an em; plus some paragraph spacing. Only a fallback
  // for a screen with too little text on it to measure, and a guard against a
  // measure that is plainly not prose — never the speed of ordinary text. The
  // floor is low because a wide line makes sparse text look sparser: a list of
  // six-word points fills a third of a phone's lines and a sixth of a
  // monitor's, and a floor of a third held the monitor's lists slow.
  const style = getComputedStyle(view);
  const fontPx = parseFloat(style.fontSize) || 16;
  const wordsPerLine = Math.max(3, (width || view.clientWidth) / (fontPx * 0.5 * 6));
  const predicted = wordsPerLine / (line * 1.15);
  const session = teleprompterSession;
  const screen = screenWords && screenHeight > line * 2
    ? Math.min(predicted * 2, Math.max(predicted * 0.5, screenWords / screenHeight))
    : (session.screenWordsPerPx || predicted);
  session.screenWordsPerPx = session.screenWordsPerPx ? session.screenWordsPerPx + 0.5 * (screen - session.screenWordsPerPx) : screen;
  words += wordless * session.screenWordsPerPx;
  height += wordless;
  const measured = words && height >= line * 2 ? words / height : 0;
  const sample = measured ? Math.min(predicted * 3, Math.max(predicted / 5, measured)) : (session.densityTarget || predicted);
  // The target the speed eases toward (easeTeleprompterDensity); the first
  // measure of a type is taken as it is.
  session.densityTarget = session.densityTarget ? session.densityTarget + 0.5 * (sample - session.densityTarget) : sample;
  if (!session.wordsPerPx) session.wordsPerPx = session.densityTarget;
}

// The speed the loop moves at now: the words a minute set, through the text's
// density, nudged by the word clock.
function teleprompterPxPerSecond() {
  const session = teleprompterSession;
  if (!session?.wordsPerPx) return 0;
  return (session.wpm / 60 / session.wordsPerPx) * paceFactor(session.clock, session.wpm);
}

function easeTeleprompterDensity(dt) {
  const session = teleprompterSession;
  if (!session.densityTarget) return;
  if (reducedMotion() || !session.wordsPerPx) {
    session.wordsPerPx = session.densityTarget;
    return;
  }
  session.wordsPerPx += (session.densityTarget - session.wordsPerPx) * (1 - Math.exp(-dt / DENSITY_EASE_S));
}

// ── The part of a pixel ─────────────────────────────────────────────────────

// `fraction` of a pixel further down than scrollTop says, as a transform on
// the scroller — the `translate` property, which restyles in half the time
// `transform` does. `will-change` with it, so the compositor moves the text it
// already has rather than drawing it again at every new fraction.
function placeSubPixel(view, fraction) {
  const shown = Math.round(fraction * 100) / 100;
  if (teleprompterSession.subPixelOn && shown === teleprompterSession.subPixel) return;
  if (!teleprompterSession.subPixelOn) {
    view.style.willChange = "translate";
    teleprompterSession.subPixelOn = true;
  }
  teleprompterSession.subPixel = shown;
  view.style.translate = `0 ${-shown}px`;
}

// Gone, with the text put on the nearer whole pixel: a paused note is plain,
// for selecting and every menu that measures it.
function clearSubPixel(view) {
  if (!teleprompterSession?.subPixelOn || !view) return;
  const session = teleprompterSession;
  const fraction = session.subPixel;
  session.subPixelOn = false;
  session.subPixel = 0;
  view.style.translate = "";
  view.style.willChange = "";
  if (fraction >= 0.5 && view.scrollTop + 1 <= view.scrollHeight - view.clientHeight) {
    markProgrammaticNotesScroll();
    view.scrollTop += 1;
  }
  session.pos = view.scrollTop;
  session.lastWritten = view.scrollTop;
}

// ── The frame ───────────────────────────────────────────────────────────────

function scheduleTeleprompterFrame() {
  if (!teleprompterSession || teleprompterSession.frame) return;
  teleprompterSession.frame = requestAnimationFrame(teleprompterFrame);
}

function stopTeleprompterFrames() {
  if (teleprompterSession?.frame) cancelAnimationFrame(teleprompterSession.frame);
  if (teleprompterSession) {
    teleprompterSession.frame = 0;
    teleprompterSession.lastFrameAt = 0;
    clearSubPixel(el.notesView);
  }
  setNotesAutoScrolling(false);
}

// A long note is built as it is read (renderNotesLazily in
// src/render/block-cache.js), and its last span may still be a placeholder when
// the scroller reaches the bottom of what exists. Not notesLazyPending: a span
// left unbuilt ABOVE a reader who started mid-book would keep that true for the
// rest of the session.
function lastSpanPending(view) {
  const chunks = view.querySelectorAll(`:scope > .${NOTES_CHUNK_CLASS}`);
  return Boolean(chunks.length && chunks[chunks.length - 1].classList.contains(NOTES_CHUNK_PENDING_CLASS));
}

function surfaceStillHere() {
  return state.viewMode === "notes" && !isNotesEditing() && isDisplayed(el.notesView)
    && !document.hidden && currentDeckKey() === teleprompterSession.deckKey;
}

function teleprompterFrame(now) {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  teleprompterSession.frame = 0;
  if (!surfaceStillHere()) {
    clearSubPixel(view);
    setNotesAutoScrolling(false);
    watchTeleprompter();
    return;
  }
  // The time the text moves by, and the time the word clock counts — see
  // src/notes/teleprompter-pace.js.
  const elapsed = teleprompterSession.lastFrameAt ? (now - teleprompterSession.lastFrameAt) / 1000 : 0;
  const dt = Math.min(FRAME_MOVE_MAX_S, elapsed);
  teleprompterSession.lastFrameAt = now;
  const target = teleprompterSession.phase === "playing" ? 1 : 0;
  if (reducedMotion()) teleprompterSession.ease = target;
  else if (target > teleprompterSession.ease) teleprompterSession.ease = Math.min(target, teleprompterSession.ease + dt / RAMP_IN_S);
  else teleprompterSession.ease = Math.max(target, teleprompterSession.ease - dt / RAMP_OUT_S);
  if (!target && teleprompterSession.ease <= 0) {
    stopTeleprompterFrames();
    return;
  }
  // A hold is putting the reader back on their line (a rotation, a resume, a
  // change of type): stand still until it has, and carry on from where it left
  // the text.
  if (teleprompterSession.holding || isReflowHolding() || isResumeLanding()) {
    clearSubPixel(view);
    setNotesAutoScrolling(false);
    resyncPosition();
    scheduleTeleprompterFrame();
    return;
  }
  if (!teleprompterSession.wordsPerPx || now - teleprompterSession.measuredAt > DENSITY_MS) {
    measureTeleprompterDensity(view);
    teleprompterSession.measuredAt = now;
  }
  easeTeleprompterDensity(dt);
  // Moved by something else — the reader's step, scroll anchoring: carried on
  // from, and not a lag to make up.
  if (Math.abs(view.scrollTop - teleprompterSession.lastWritten) > 1.5) {
    teleprompterSession.pos = view.scrollTop;
    rebaseWordClock(teleprompterSession.clock);
    teleprompterSession.moves += 1;
  }
  const max = Math.max(0, view.scrollHeight - view.clientHeight);
  const step = Math.max(0, Math.min(max - teleprompterSession.pos, teleprompterPxPerSecond() * teleprompterSession.ease * dt));
  teleprompterSession.pos = Math.min(max, teleprompterSession.pos + step);
  if (teleprompterSession.phase === "playing") {
    const { clock } = teleprompterSession;
    wordsDueFor(clock, teleprompterSession.wpm, teleprompterSession.ease, Math.min(FRAME_COUNT_MAX_S, elapsed));
    wordsDone(clock, step * teleprompterSession.wordsPerPx, teleprompterSession.ease >= 1);
  }
  setNotesAutoScrolling(true);
  // The whole pixels to scrollTop, the rest to the transform — see the header.
  const whole = Math.floor(teleprompterSession.pos);
  if (view.scrollTop !== whole) {
    markProgrammaticNotesScroll();
    view.scrollTop = whole;
  }
  teleprompterSession.lastWritten = view.scrollTop;
  if (!reducedMotion()) placeSubPixel(view, view.scrollTop === whole ? teleprompterSession.pos - whole : 0);
  if (teleprompterSession.phase === "playing" && teleprompterSession.pos >= max - 0.5 && !lastSpanPending(view)) {
    finishTeleprompter();
    return;
  }
  scheduleTeleprompterFrame();
}

// ── The screen, kept on ─────────────────────────────────────────────────────
//
// A phone dims after thirty seconds without a touch, and a teleprompter is
// thirty seconds without a touch by design. Scrolling by hand is a touch every
// so often, but a slow reader at arm's length can still go thirty seconds.
const SCREEN_ON_PHASES = new Set(["playing", "manual"]);

async function holdScreenAwake() {
  if (!teleprompterSession || !teleprompterSession.settings.wake || teleprompterSession.wakeLock || teleprompterSession.wakeRequested) return;
  if (typeof navigator === "undefined" || !navigator.wakeLock?.request) return;
  const owner = teleprompterSession;
  owner.wakeRequested = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    owner.wakeRequested = false;
    if (teleprompterSession !== owner || !SCREEN_ON_PHASES.has(owner.phase) || !owner.settings.wake) {
      lock.release?.().catch?.(() => {});
      return;
    }
    owner.wakeLock = lock;
    lock.addEventListener?.("release", () => {
      if (owner.wakeLock === lock) owner.wakeLock = null;
    });
  } catch {
    owner.wakeRequested = false;
  }
}

function letScreenSleep() {
  const lock = teleprompterSession?.wakeLock;
  if (teleprompterSession) teleprompterSession.wakeLock = null;
  try { lock?.release?.()?.catch?.(() => {}); } catch { /* already released */ }
}

// ── Painting ────────────────────────────────────────────────────────────────

const STATUS_TEXT = {
  countdown: "Starting",
  paused: "Paused",
  ended: "End of the notes",
  manual: "Scrolling by hand"
};

// ── The time left ───────────────────────────────────────────────────────────
//
// How long the loop will take to bring the last line to the band, counted in
// WORDS: the loop moves the words at the band at the words a minute set (the
// word clock, src/notes/teleprompter-pace.js, holds it there), so the time is
// the words still to pass over the speed, as the clock counts them.
//
// The words left are the reading-progress line's (src/stats/reading-progress.js):
// the note's markdown, list dashes and table bars and link targets and all,
// counted from Notes' reading line. Not the words the band counts — a table's
// bars are not, a picture's height is counted at the text's pace, and a code
// block's tokens are something between. So the session learns, from the exact
// readings (a captured anchor, never the estimate between two), how many of
// the band's words go to one of those markdown words (lambda): anything in the
// one and not the other is then in both sides of the sum and cancels. Lambda
// barely moves from prose to lists to tables, as both sides count the same
// stretch of text.
//
// It used to be done in pixels — the markdown words a pixel held, over the
// pixels a second the loop had averaged so far. But the speed in pixels now
// follows the text at the band, faster through a list than through prose, and
// the average of the part read was a poor guide to the part to come: halfway
// down a note of prose, links, tables and code it was out by 15–20%.
//
// Left in words = (markdown words left at the last reading) × lambda − the
// words between Notes' reading line and the band − the words the clock has
// counted since. Between two readings it only goes down.

// Lambda starts at 1 as though this many words had been read at it, and only
// leaves it as the words actually read outweigh them: the first readings span
// a heading and a paragraph or two, and taken alone they tipped it by a tenth.
const LAMBDA_PRIOR_WORDS = 300;

// How much of the difference between a new reading and what the last one
// said is kept: see foldExactReading.
const READING_TRUST_KEEP = 0.5;

// A new exact reading corrects the estimate over this long rather than at
// once, so the number keeps counting down instead of jumping back up.
const LEFT_SETTLE_MS = 4000;

function forgetTimeLeftLearning() {
  if (!teleprompterSession) return;
  teleprompterSession.lambda = 0;
  teleprompterSession.lambdaBase = null;
  teleprompterSession.leftFix = null;
  teleprompterSession.typeAt = performance.now();
  teleprompterSession.leftCarry = null;
}

// The clock's words at the moment a reading was taken: it is folded in up to a
// watch tick later, and the text has moved on since.
function clockWordsAt(at) {
  const session = teleprompterSession;
  const since = session.phase === "playing" && session.ease >= 1 ? Math.max(0, performance.now() - at) / 1000 : 0;
  return session.clock.done - (session.wpm / 60) * since;
}

// True when a reading was taken in.
function foldExactReading() {
  const session = teleprompterSession;
  const exact = lastExactNotesReading();
  if (!exact || exact.at <= session.exactAt || exact.at < session.typeAt) return false;
  session.exactAt = exact.at;
  // Taken with Notes' reading line still in the lead-in above the first line:
  // all the words are still to come at a scroll that has passed none of them.
  if (exact.scrollTop + (session.readingLine || 0) < (session.textTop || 0)) return false;
  const reading = { wordsLeft: exact.wordsLeft, scrollTop: exact.scrollTop, done: clockWordsAt(exact.at), moves: session.moves, trim: 0 };
  const base = session.lambdaBase;
  const fix = session.leftFix;
  // Further down with more words still to go cannot be: an anchor that found
  // the same words earlier in the note. Not learned from, not shown.
  if (fix && reading.scrollTop >= fix.scrollTop && reading.wordsLeft > fix.wordsLeft) return false;
  // What the last reading says is left now, before this one is taken in.
  const expected = fix && fix.moves === session.moves ? wordsLeftFrom(fix) : null;
  // Back up the note, or moved by anything but the loop since (a step, a
  // resume, a pause), is a new start: the clock did not count those words.
  if (!base || base.moves !== reading.moves || reading.scrollTop < base.scrollTop) {
    session.lambdaBase = reading;
  } else {
    const words = base.wordsLeft - reading.wordsLeft;
    const done = reading.done - base.done;
    if (words > 0 && done > 0) session.lambda = (done + LAMBDA_PRIOR_WORDS) / (words + LAMBDA_PRIOR_WORDS);
  }
  // An anchor lands a few dozen words either side of where the band really
  // is, and taken at its word the estimate jumped by that much at every one.
  // Met halfway instead, the misses average out over the readings that
  // follow, and a real difference is still made up within two or three.
  if (expected != null) reading.trim = (expected - wordsLeftFrom(reading)) * READING_TRUST_KEEP;
  session.leftFix = reading;
  return true;
}

// The band's words still to pass, from a reading: its markdown words, at
// lambda, less those between Notes' reading line and the band, less what the
// clock has counted since.
function wordsLeftFrom(fix) {
  const session = teleprompterSession;
  return fix.wordsLeft * (session.lambda || 1) + fix.trim
    - (session.lineGap || 0) * (session.wordsPerPx || 0) - (session.clock.done - fix.done);
}

// What is left of the last correction, fading to nothing over LEFT_SETTLE_MS.
function leftCarryMs(now) {
  const carry = teleprompterSession.leftCarry;
  if (!carry) return 0;
  return carry.ms * Math.max(0, 1 - (now - carry.at) / LEFT_SETTLE_MS);
}

function teleprompterTimeLeftMs() {
  const session = teleprompterSession;
  if (!session || session.phase === "ended") return null;
  // By hand: the reader's own speed, as the progress row reckons it.
  if (session.phase === "manual") return readingTimeLeft()?.leftMs ?? null;
  if (!session.wpm) return null;
  const now = performance.now();
  const before = session.leftFix ? rawTimeLeftMs() : null;
  const after = foldExactReading() ? rawTimeLeftMs() : before;
  if (after == null) return null;
  if (before != null && after !== before) session.leftCarry = { ms: leftCarryMs(now) + before - after, at: now };
  return Math.max(0, after + leftCarryMs(now));
}

function rawTimeLeftMs() {
  const session = teleprompterSession;
  const rate = session.wpm / 60;
  // Until it is learned, a markdown word is a word: so it is, in prose.
  const lambda = session.lambda || 1;
  const fix = session.leftFix;
  if (fix && fix.moves === session.moves) return (Math.max(0, wordsLeftFrom(fix)) / rate) * 1000;
  // Moved since the last reading: the progress row's own estimate, until the
  // next one.
  const words = liveNotesWordsLeft();
  return words > 0 ? ((words * lambda) / rate) * 1000 : null;
}

function timeLeftText() {
  const ms = teleprompterTimeLeftMs();
  if (!(ms > 0)) return "";
  return `≈ ${formatDuration(ms, { short: true })} left`;
}

function paintTeleprompter() {
  if (!teleprompterSession) return;
  paintTeleprompterPanel({
    phase: teleprompterSession.phase,
    wpm: teleprompterSession.wpm,
    fontSize: teleprompterSession.fontSize,
    leftText: teleprompterSession.phase === "ended" ? "" : timeLeftText(),
    countdown: teleprompterSession.countdownLeft,
    tucked: teleprompterSession.tucked,
    resumeProgress: teleprompterSession.resumeProgress,
    settings: teleprompterSession.settings,
    measuredWpm: measuredTeleprompterWpm(),
    statusText: teleprompterSession.phase === "playing" ? `Playing, ${teleprompterSession.wpm} words a minute` : STATUS_TEXT[teleprompterSession.phase] || ""
  });
}

export function paintTeleprompterToggles() {
  const on = Boolean(teleprompterSession);
  const button = el.teleprompterBtn;
  if (button) {
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.title = on
      ? "Leave the teleprompter — back to the normal Notes text"
      : "Teleprompter — the text scrolls by itself at the speed you set; touch it to pause";
  }
  teleprompterChangedHook?.();
}

// ── Starting and leaving ────────────────────────────────────────────────────

const panelHandlers = {
  action: (name) => onTeleprompterAction(name),
  setting: (key, value, options) => onTeleprompterSetting(key, value, options),
  // The PDF's teleprompter is taking the panel: this one is behind Cards or a
  // PDF by then, so nothing is landed on a note nobody is looking at.
  evict: () => exitTeleprompter({ land: false })
};

export function startTeleprompter() {
  const view = el.notesView;
  const stage = el.notesStage;
  if (teleprompterSession || !view || !stage) return false;
  if (state.viewMode !== "notes" || isNotesEditing() || !isDisplayed(view)) return false;
  const settings = readTeleprompterSettings();
  const notesFontPx = parseFloat(getComputedStyle(view).fontSize) || 16;
  // Where the reader is, before anything moves: the line they are reading, or
  // the very top, which the lead-in then puts in the band.
  const pagedBefore = isNotesPaged();
  const atTop = !pagedBefore && view.scrollTop <= 1;
  const anchor = atTop ? null : measureLineAnchor(view, readingLineY(view));
  teleprompterSession = {
    phase: "paused",
    deckKey: currentDeckKey(),
    settings,
    wpm: settings.wpm || measuredTeleprompterWpm() || TELEPROMPTER_FALLBACK_WPM,
    fontSize: settings.fontSize || clampToRange("fontSize", Math.round(notesFontPx * 1.25)),
    pagedBefore,
    focusSetByUs: false,
    pos: 0,
    lastWritten: 0,
    ease: 0,
    frame: 0,
    lastFrameAt: 0,
    wordsPerPx: 0,
    densityTarget: 0,
    screenWordsPerPx: 0,
    clock: newWordClock(),
    measuredAt: 0,
    subPixel: 0,
    subPixelOn: false,
    lambda: 0,
    lambdaBase: null,
    moves: 0,
    leftFix: null,
    leftCarry: null,
    exactAt: 0,
    typeAt: 0,
    lineGap: 0,
    readingLine: 0,
    textTop: 0,
    idleSave: false,
    wasAway: false,
    holding: 1,
    lead: 0,
    pauseReason: null,
    lastInputAt: performance.now(),
    countdownLeft: 0,
    countdownTimer: 0,
    watchTimer: 0,
    resumeProgress: null,
    tucked: false,
    wakeLock: null,
    wakeRequested: false,
    resizeObserver: null,
    capturedAt: 0
  };
  if (pagedBefore) setNotesPagedSuspended(true);
  view.classList.add("is-teleprompter");
  applyTeleprompterType(view);
  ensureTeleprompterPanel(stage, panelHandlers);
  relayoutTeleprompter();
  if (settings.focus && !isFocusModeActive()) {
    setFocusMode(true);
    teleprompterSession.focusSetByUs = true;
  }
  const owner = teleprompterSession;
  const landed = () => {
    if (teleprompterSession !== owner) return;
    teleprompterSession.holding = Math.max(0, teleprompterSession.holding - 1);
    resyncPosition();
  };
  if (atTop) {
    markProgrammaticNotesScroll();
    view.scrollTop = 0;
    requestAnimationFrame(landed);
  } else {
    keepLineAt(view, anchor, () => bandLineY(view), landed);
  }
  if (typeof ResizeObserver === "function") {
    teleprompterSession.resizeObserver = new ResizeObserver(() => {
      relayoutTeleprompter({ compensate: true });
      // A new width re-wraps the text: the words a pixel holds are new too.
      forgetTimeLeftLearning();
    });
    teleprompterSession.resizeObserver.observe(view);
  }
  teleprompterSession.watchTimer = setInterval(watchTeleprompter, WATCH_MS);
  view.addEventListener("wheel", onTeleprompterWheel, { passive: false });
  paintTeleprompterToggles();
  if (settings.scroll === "manual") enterManualTeleprompter();
  else beginTeleprompterCountdown();
  return true;
}

// `land`: put the line the reader was on back where Notes keeps its reading
// line. Not when the note on screen is no longer the one that was read.
export function exitTeleprompter({ land = true } = {}) {
  if (!teleprompterSession) return;
  const view = el.notesView;
  const ending = teleprompterSession;
  clearInterval(ending.watchTimer);
  clearInterval(ending.countdownTimer);
  stopTeleprompterFrames();
  letScreenSleep();
  ending.resizeObserver?.disconnect();
  view?.removeEventListener("wheel", onTeleprompterWheel);
  if (view) stopGlide(view);
  const canLand = land && view && isDisplayed(view) && !isNotesEditing();
  const anchor = canLand ? measureLineAnchor(view, bandLineY(view)) : null;
  // Ended while the note is out of sight (the PDF's teleprompter taking the
  // panel from behind another tab). Taking the larger type off a hidden note
  // leaves its scrollTop measured on text that is no longer that size, so the
  // reader would come back somewhere else. Hand the place the session last
  // saved to the resume that runs when Notes is next shown — for this same
  // file only: on a file switch the new file's own resume owns that slot.
  const hiddenHere = !canLand && view && !isDisplayed(view)
    && currentDeckKey() === ending.deckKey
    && currentReadingAnchorDeckKey === ending.deckKey && currentReadingAnchor;
  if (hiddenHere) deferNotesResume(ending.deckKey, currentReadingAnchor);
  else if (canLand) saveTeleprompterPlace({ flush: true });
  teleprompterSession = null;
  closeTeleprompterSheet();
  removeTeleprompterPanel();
  if (view) {
    view.classList.remove("is-teleprompter");
    clearTeleprompterType(view);
  }
  if (ending.pagedBefore) {
    setNotesPagedSuspended(false);
    if (anchor?.block?.isConnected) revealInPagedNotes(anchor.block);
  } else if (anchor && view) {
    keepLineAt(view, anchor, () => readingLineY(view));
  }
  if (ending.focusSetByUs && isFocusModeActive()) setFocusMode(false);
  scheduleReadingAnchorCapture();
  paintTeleprompterToggles();
}

export function toggleTeleprompter() {
  if (teleprompterSession) exitTeleprompter();
  else startTeleprompter();
}

// ── Playing, pausing, the countdown and the end ─────────────────────────────

function beginTeleprompterCountdown() {
  if (!teleprompterSession) return;
  clearInterval(teleprompterSession.countdownTimer);
  const seconds = teleprompterSession.settings.countdown;
  if (!seconds) {
    playTeleprompter();
    return;
  }
  teleprompterSession.phase = "countdown";
  teleprompterSession.countdownLeft = seconds;
  teleprompterSession.resumeProgress = null;
  teleprompterSession.countdownTimer = setInterval(() => {
    if (!teleprompterSession) return;
    teleprompterSession.countdownLeft -= 1;
    if (teleprompterSession.countdownLeft <= 0) playTeleprompter();
    else paintTeleprompter();
  }, 1000);
  paintTeleprompter();
}

function playTeleprompter() {
  if (!teleprompterSession) return;
  clearInterval(teleprompterSession.countdownTimer);
  teleprompterSession.countdownTimer = 0;
  teleprompterSession.phase = "playing";
  teleprompterSession.pauseReason = null;
  teleprompterSession.resumeProgress = null;
  teleprompterSession.tucked = false;
  teleprompterSession.lastFrameAt = 0;
  resyncPosition();
  rebaseWordClock(teleprompterSession.clock, { measure: true });
  holdScreenAwake();
  scheduleTeleprompterFrame();
  paintTeleprompter();
}

// `reason`: "button" (❚❚, Space) eases to a stop; "reader" (a press on the
// text), "away" (another tab, Home) and "hidden" (the app in the background)
// stop dead. Only "reader" may carry on by itself.
export function pauseTeleprompter(reason = "button") {
  if (!teleprompterSession || (teleprompterSession.phase !== "playing" && teleprompterSession.phase !== "countdown")) return;
  clearInterval(teleprompterSession.countdownTimer);
  teleprompterSession.countdownTimer = 0;
  teleprompterSession.phase = "paused";
  teleprompterSession.pauseReason = reason;
  teleprompterSession.lastInputAt = performance.now();
  teleprompterSession.resumeProgress = null;
  if (reason !== "button" || reducedMotion()) {
    stopTeleprompterFrames();
    teleprompterSession.ease = 0;
  }
  letScreenSleep();
  // The loop announces each of its frames as the app's own scroll, so nothing
  // was saving where the reader had got to; this is where they are now —
  // taken now, before the press that paused can hide the note (see
  // saveTeleprompterPlace). An eased stop ("button") is still moving, so the
  // capture after it settles stays as well.
  saveTeleprompterPlace({ flush: reason === "hidden" || reason === "away" });
  scheduleReadingAnchorCapture();
  paintTeleprompter();
}

function teleprompterAtEnd(view) {
  return view.scrollTop >= view.scrollHeight - view.clientHeight - teleprompterLineHeight(view);
}

export function resumeTeleprompter() {
  if (!teleprompterSession || teleprompterSession.phase === "manual") return;
  // From the end, Space starts again from the top — unless the reader has
  // since scrolled back up to something, which is where they meant.
  if (teleprompterSession.phase === "ended") {
    if (el.notesView && !teleprompterAtEnd(el.notesView)) playTeleprompter();
    else restartTeleprompter();
    return;
  }
  if (teleprompterSession.phase === "playing") return;
  playTeleprompter();
}

function restartTeleprompter() {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  markProgrammaticNotesScroll();
  view.scrollTop = 0;
  resyncPosition();
  beginTeleprompterCountdown();
}

function finishTeleprompter() {
  if (!teleprompterSession) return;
  teleprompterSession.phase = "ended";
  teleprompterSession.pauseReason = null;
  stopTeleprompterFrames();
  letScreenSleep();
  saveTeleprompterPlace({ flush: true });
  paintTeleprompter();
}

function togglePlayTeleprompter() {
  if (!teleprompterSession || teleprompterSession.phase === "manual") return;
  if (teleprompterSession.phase === "playing") pauseTeleprompter("button");
  else resumeTeleprompter();
}

// Scrolling by hand: the loop stops where it is, and nothing will start it
// again until the reader chooses "By itself".
function enterManualTeleprompter() {
  const session = teleprompterSession;
  if (!session) return;
  clearInterval(session.countdownTimer);
  session.countdownTimer = 0;
  stopTeleprompterFrames();
  session.ease = 0;
  session.phase = "manual";
  session.pauseReason = null;
  session.resumeProgress = null;
  holdScreenAwake();
  paintTeleprompter();
}

// Back to "By itself", paused: ▶ is there to press, and nothing moves before
// the reader does.
function leaveManualTeleprompter() {
  const session = teleprompterSession;
  if (!session || session.phase !== "manual") return;
  session.phase = "paused";
  session.pauseReason = "button";
  session.lastInputAt = performance.now();
  letScreenSleep();
  saveTeleprompterPlace();
  paintTeleprompter();
}

function applyTeleprompterScrollMode() {
  if (!teleprompterSession) return;
  if (teleprompterSession.settings.scroll === "manual") {
    if (teleprompterSession.phase !== "manual") enterManualTeleprompter();
  } else {
    leaveManualTeleprompter();
  }
}

// ── While it is open ────────────────────────────────────────────────────────

// Something the reader is in the middle of: a finger down, a selection being
// made or held, a highlight's menu, a dialog. The bar gets out of the way of
// all of these while paused, and none of them is a moment to carry on.
function teleprompterReaderBusy() {
  return readerTouchDown()
    || touchGestureHoldsSurface()
    || selectionGestureIsLive()
    || isSelectionAdjusting()
    || Boolean(el.selectionFloat && !el.selectionFloat.hidden)
    || notesSelectionHoldsText()
    || Boolean(touchSelectionRange())
    || isMarkMenuOpen()
    || isAdjustHandlesOpen()
    || isHighlightNoteEditorOpen()
    || anyModalOpen()
    || isNotesHeadMoreOpen();
}

function watchTeleprompter() {
  if (!teleprompterSession) return;
  // A different note, or the raw editor: the place this session was keeping
  // is not on screen any more, and neither is anything to keep it for.
  if (currentDeckKey() !== teleprompterSession.deckKey || isNotesEditing()) {
    exitTeleprompter({ land: false });
    return;
  }
  if (state.viewMode !== "notes" || !isDisplayed(el.notesView) || document.hidden) {
    if (teleprompterSession.phase === "manual") {
      if (!teleprompterSession.wasAway) letScreenSleep();
      teleprompterSession.wasAway = true;
    } else {
      pauseTeleprompter(document.hidden && isDisplayed(el.notesView) && state.viewMode === "notes" ? "hidden" : "away");
    }
    return;
  }
  if (teleprompterSession.phase === "manual") {
    // Back from another tab or the background: the browser let go of the
    // screen lock there, so it is asked for again — once, not every tick.
    if (teleprompterSession.wasAway) {
      teleprompterSession.wasAway = false;
      holdScreenAwake();
    }
    teleprompterSession.tucked = teleprompterReaderBusy();
    paintTeleprompter();
    return;
  }
  // Scrolled back up from the end: the bar offers ▶ again rather than only
  // "From the top".
  if (teleprompterSession.phase === "ended" && !teleprompterAtEnd(el.notesView)) {
    teleprompterSession.phase = "paused";
    teleprompterSession.pauseReason = "button";
  }
  if (teleprompterSession.phase !== "paused") {
    if (teleprompterSession.phase === "playing") {
      if (performance.now() - teleprompterSession.capturedAt >= PLAY_CAPTURE_MS) savePlaceWhenIdle();
      paintTeleprompter();
    }
    return;
  }
  const busy = teleprompterReaderBusy();
  teleprompterSession.tucked = busy;
  const wait = teleprompterSession.settings.autoResume * 1000;
  if (teleprompterSession.pauseReason === "reader" && wait > 0 && !isTeleprompterSheetOpen()) {
    const now = performance.now();
    if (busy) teleprompterSession.lastInputAt = now;
    teleprompterSession.resumeProgress = Math.min(1, (now - teleprompterSession.lastInputAt) / wait);
    if (teleprompterSession.resumeProgress >= 1) {
      playTeleprompter();
      return;
    }
  } else {
    teleprompterSession.resumeProgress = null;
  }
  paintTeleprompter();
}

// ── The bar and the sheet ───────────────────────────────────────────────────

function changeTeleprompterSpeed(delta) {
  if (!teleprompterSession) return;
  setTeleprompterSetting("wpm", teleprompterSession.wpm + delta, { commit: true });
}

function changeTeleprompterSize(delta) {
  if (!teleprompterSession) return;
  setTeleprompterSetting("fontSize", teleprompterSession.fontSize + delta, { commit: true });
}

// ── Steps by the line ───────────────────────────────────────────────────────
//
// ↑ ↓ ← →, the page keys and a mouse wheel's clicks (src/notes/band-steps.js):
// so many of the note's own lines, ending with one on the band. A line is on
// the band when its middle is where the band's first whole line has its
// middle — the band's top, plus half of whatever it has over its whole lines,
// plus half a line.

function bandSlotMiddle(view) {
  const geometry = bandGeometry(view);
  const whole = Math.max(1, Math.floor(teleprompterSession.settings.bandSize));
  return {
    line: geometry.line,
    mid: view.getBoundingClientRect().top + geometry.bandTop
      + Math.max(0, (geometry.bandHeight - whole * geometry.line) / 2) + geometry.line / 2
  };
}

// Down the left edge of the text under the band, where every line starts —
// a short last line of a paragraph does not reach the middle.
function lineProbeX(view, y) {
  const block = notesBlockAtReadingLineGeometric(y);
  const box = (block && view.contains(block) ? block : view).getBoundingClientRect();
  return box.left + Math.min(6, Math.max(1, box.width / 4));
}

// The scrollTop that puts the `lines`-th line after (or, negative, before)
// the one on the band onto the band — counted from where a glide under way is
// going. 0 lines is the nearest line. A step past what is on screen is taken
// at the line height, and set right when it lands (alignTeleprompterToBand).
function teleprompterStepTarget(view, lines) {
  const { line, mid } = bandSlotMiddle(view);
  const pending = pendingGlidePx(view);
  const at = mid + pending;
  const box = view.getBoundingClientRect();
  const x = lineProbeX(view, mid);
  let delta = pending + lines * line;
  if (lines > 0) {
    const middles = lineMiddlesBetween(x, at + 2, box.top + view.clientHeight - 2, line);
    if (middles.length >= lines) delta = middles[lines - 1] - mid;
  } else if (lines < 0) {
    // From the top of the screen: a gap between paragraphs can be taller than
    // the lines it is counted in.
    const middles = lineMiddlesBetween(x, box.top + 1, at - 2, line);
    if (middles.length >= -lines) delta = middles[middles.length + lines] - mid;
  } else {
    const middles = lineMiddlesBetween(x, mid - line * 0.75, mid + line * 0.75, line);
    if (!middles.length) return view.scrollTop;
    delta = middles.reduce((best, middle) => (Math.abs(middle - mid) < Math.abs(best - mid) ? middle : best)) - mid;
  }
  return Math.max(0, Math.min(view.scrollHeight - view.clientHeight, view.scrollTop + delta));
}

function alignTeleprompterToBand() {
  const view = el.notesView;
  if (!teleprompterSession || !view || teleprompterSession.phase === "playing") return;
  const target = teleprompterStepTarget(view, 0);
  if (Math.abs(target - view.scrollTop) >= 1) glideScrollTo(view, target);
}

// Playing, the step is made at once and the loop carries on from it, as it
// follows any other move; otherwise it glides.
function stepTeleprompterLines(lines) {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  const target = teleprompterStepTarget(view, lines);
  if (teleprompterSession.phase === "playing" || teleprompterSession.phase === "countdown") {
    stopGlide(view);
    markProgrammaticNotesScroll();
    view.scrollTop = target;
    resyncPosition();
  } else {
    glideScrollTo(view, target);
  }
  if (teleprompterSession.phase === "ended" && lines < 0) {
    teleprompterSession.phase = "paused";
    teleprompterSession.pauseReason = "button";
    paintTeleprompter();
  }
}

// A screen, less two lines so the eye has somewhere to pick up from: the last
// line on screen comes to the band going down. Going up, the lines it lands on
// are not drawn yet to count, so it is a screen's height, set onto the band
// once it is there.
function pageTeleprompter(direction) {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  if (teleprompterSession.phase === "playing" || teleprompterSession.phase === "countdown") pauseTeleprompter("reader");
  const { line, mid } = bandSlotMiddle(view);
  const box = view.getBoundingClientRect();
  if (direction > 0) {
    const at = mid + pendingGlidePx(view);
    const middles = lineMiddlesBetween(lineProbeX(view, mid), at + 2, box.top + view.clientHeight - line, line);
    if (middles.length) {
      glideScrollTo(view, view.scrollTop + middles[middles.length - 1] - mid);
      return;
    }
  }
  const jump = Math.max(line, view.clientHeight - 2 * line);
  glideScrollTo(view, view.scrollTop + pendingGlidePx(view) + direction * jump, { done: alignTeleprompterToBand });
}

function jumpTeleprompterTo(end) {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  if (teleprompterSession.phase === "playing" || teleprompterSession.phase === "countdown") pauseTeleprompter("reader");
  stopGlide(view);
  view.scrollTop = end ? view.scrollHeight - view.clientHeight : 0;
}

// A click of a mouse wheel over the note: whole lines onto the band. Only
// while a session is open (added and taken off with it), so the note's
// ordinary scrolling keeps its passive listeners. A trackpad, and anything
// else the wheel test is not sure of, scrolls as the browser does.
function onTeleprompterWheel(event) {
  if (!teleprompterSession || !isNotchedWheel(event) || teleprompterPanelContains(event.target)) return;
  event.preventDefault();
  // A press of the wheel while it plays has already paused it (onReaderWheel,
  // in the capture phase), so this glides.
  stepTeleprompterLines(wheelNotches(event) * WHEEL_LINES);
}

function onTeleprompterAction(name) {
  if (!teleprompterSession) return;
  if (name === "play") togglePlayTeleprompter();
  else if (name === "again") restartTeleprompter();
  else if (name === "exit") exitTeleprompter();
  else if (name === "slower") changeTeleprompterSpeed(-TELEPROMPTER_RANGES.wpm.step);
  else if (name === "faster") changeTeleprompterSpeed(TELEPROMPTER_RANGES.wpm.step);
  else if (name === "smaller") changeTeleprompterSize(-2);
  else if (name === "bigger") changeTeleprompterSize(2);
  else if (name === "settings") toggleTeleprompterSheet();
  else if (name === "sheet-close") closeTeleprompterSheet();
  else if (name === "use-my-speed") {
    const mine = measuredTeleprompterWpm();
    if (mine) setTeleprompterSetting("wpm", mine, { commit: true });
  } else if (name === "reset") resetTeleprompterSettings();
  paintTeleprompter();
}

function onTeleprompterSetting(key, value, { commit = true } = {}) {
  setTeleprompterSetting(key, value, { commit });
}

const TYPE_KEYS = new Set(["fontSize", "lineHeight", "width", "font"]);

// One setting, applied to the open session at once and kept when `commit` (a
// slider is previewed on every `input` and kept on `change`).
function setTeleprompterSetting(key, value, { commit = true } = {}) {
  if (!teleprompterSession) return;
  const view = el.notesView;
  let next = value;
  if (TELEPROMPTER_RANGES[key]) {
    next = clampToRange(key, value);
    if (next === null) return;
  }
  if (key === "wpm") {
    if (next !== teleprompterSession.wpm) rebaseWordClock(teleprompterSession.clock, { measure: true });
    teleprompterSession.wpm = next;
  } else if (key === "fontSize") {
    if (next !== teleprompterSession.fontSize) {
      holdBandPlace(() => {
        teleprompterSession.fontSize = next;
        applyTeleprompterType(view);
        relayoutTeleprompter();
      });
    }
  } else if (TYPE_KEYS.has(key) || key === "bandPos" || key === "bandSize") {
    if (teleprompterSession.settings[key] !== next) {
      holdBandPlace(() => {
        teleprompterSession.settings = { ...teleprompterSession.settings, [key]: next };
        applyTeleprompterType(view);
        relayoutTeleprompter();
      });
    }
  } else {
    teleprompterSession.settings = { ...teleprompterSession.settings, [key]: next };
    if (key === "dim" || key === "band") relayoutTeleprompter();
    if (key === "scroll") applyTeleprompterScrollMode();
    if (key === "focus") {
      if (next && !isFocusModeActive()) {
        setFocusMode(true);
        teleprompterSession.focusSetByUs = true;
      } else if (!next && teleprompterSession.focusSetByUs && isFocusModeActive()) {
        setFocusMode(false);
        teleprompterSession.focusSetByUs = false;
      }
    }
    if (key === "wake") {
      if (!next) letScreenSleep();
      else if (teleprompterSession.phase === "playing") holdScreenAwake();
    }
  }
  if (commit) {
    const stored = { ...teleprompterSession.settings };
    if (key === "wpm") stored.wpm = teleprompterSession.wpm;
    if (key === "fontSize") stored.fontSize = next;
    teleprompterSession.settings = writeTeleprompterSettings({ ...readTeleprompterSettings(), ...stored });
  }
  paintTeleprompter();
}

function resetTeleprompterSettings() {
  if (!teleprompterSession) return;
  const view = el.notesView;
  const defaults = writeTeleprompterSettings({});
  holdBandPlace(() => {
    teleprompterSession.settings = defaults;
    teleprompterSession.wpm = measuredTeleprompterWpm() || TELEPROMPTER_FALLBACK_WPM;
    // A quarter up on what Notes itself is set to, read off the root because
    // the note's own value is the teleprompter's.
    const rootSize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--notes-font-size")) || 16;
    teleprompterSession.fontSize = clampToRange("fontSize", Math.round(rootSize * 1.25));
    applyTeleprompterType(view);
    relayoutTeleprompter();
  });
  applyTeleprompterScrollMode();
}

// ── Input ───────────────────────────────────────────────────────────────────

function onReaderPress(event) {
  if (!teleprompterSession) return;
  teleprompterSession.lastInputAt = performance.now();
  if (teleprompterPanelContains(event.target)) {
    wakeTeleprompterBar();
    return;
  }
  if (teleprompterSession.phase === "playing" || teleprompterSession.phase === "countdown") pauseTeleprompter("reader");
}

function onReaderWheel(event) {
  if (!teleprompterSession) return;
  teleprompterSession.lastInputAt = performance.now();
  if (teleprompterPanelContains(event.target)) return;
  if (el.notesStage?.contains(event.target)) onReaderPress(event);
}

// Keys only while the teleprompter is on screen, never in a field, never with
// a modifier (Ctrl+. and Ctrl+Q belong to src/main.js), never over a dialog.
// Escape is not here: it goes through closeTopmostOverlay like every other
// layer (src/ui/back-gesture.js), except out of the sheet's own sliders, where
// main.js's handler never sees it.
function onTeleprompterKey(event) {
  if (!teleprompterSession || !teleprompterOnScreen()) return;
  const target = event.target;
  if (event.key === "Escape") {
    if (isTeleprompterSheetOpen() && teleprompterPanelContains(target)) {
      event.preventDefault();
      event.stopPropagation();
      closeTeleprompterSheet();
    }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
  if (anyModalOpen()) return;
  teleprompterSession.lastInputAt = performance.now();
  const act = (fn) => {
    event.preventDefault();
    fn();
  };
  const manual = teleprompterSession.phase === "manual";
  // The keys move the note, whatever has the focus: they used to be left to
  // the browser, which scrolls only the element the keyboard is on — after a
  // press on the bar, that button, and nothing moved.
  switch (event.key) {
    case " ":
    case "Spacebar":
      // A focused button, link or cloze takes its own Space.
      if (target?.closest?.("button, a, .cloze, [role='button']")) return;
      if (manual) act(() => pageTeleprompter(event.shiftKey ? -1 : 1));
      else act(togglePlayTeleprompter);
      return;
    // ↑ ↓ a line; with Shift, the speed.
    case "ArrowUp":
      if (!event.shiftKey) act(() => stepTeleprompterLines(-1));
      else if (!manual) act(() => changeTeleprompterSpeed(TELEPROMPTER_RANGES.wpm.step));
      return;
    case "ArrowDown":
      if (!event.shiftKey) act(() => stepTeleprompterLines(1));
      else if (!manual) act(() => changeTeleprompterSpeed(-TELEPROMPTER_RANGES.wpm.step));
      return;
    case "ArrowLeft": act(() => stepTeleprompterLines(-2)); return;
    case "ArrowRight": act(() => stepTeleprompterLines(2)); return;
    case "+":
    case "=": act(() => changeTeleprompterSize(2)); return;
    case "-":
    case "_": act(() => changeTeleprompterSize(-2)); return;
    case "PageUp": act(() => pageTeleprompter(-1)); return;
    case "PageDown": act(() => pageTeleprompter(1)); return;
    case "Home": act(() => jumpTeleprompterTo(false)); return;
    case "End": act(() => jumpTeleprompterTo(true)); return;
    default:
  }
}

export function initTeleprompter() {
  // Another file opening ends the session now, before its note is rendered —
  // see onDeckSwap.
  onDeckSwap(() => exitTeleprompter({ land: false }));
  // Capture phase, so the stop lands before any surface's own handler — above
  // all touch-selection's press timer (see the header).
  document.addEventListener("pointerdown", onReaderPress, { capture: true, passive: true });
  document.addEventListener("touchstart", onReaderPress, { capture: true, passive: true });
  document.addEventListener("wheel", onReaderWheel, { capture: true, passive: true });
  document.addEventListener("keydown", onTeleprompterKey, { capture: true });
  // Dragging a selection's handles moves no pointer the listeners above see
  // after the first touch, but it changes the selection: still the reader at
  // work, so the wait before carrying on starts again.
  document.addEventListener("selectionchange", () => {
    if (teleprompterSession) teleprompterSession.lastInputAt = performance.now();
  });
  document.addEventListener("visibilitychange", () => {
    if (teleprompterSession && document.hidden) pauseTeleprompter("hidden");
  });
  el.teleprompterBtn?.addEventListener("click", () => toggleTeleprompter());
  paintTeleprompterToggles();
}
