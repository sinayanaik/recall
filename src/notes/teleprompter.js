// The teleprompter: Notes that scroll by themselves, at a speed the reader
// sets, under a band that marks the line to read.
//
// "Reading articles in the notes I have imported, it is very hard to scroll" —
// so the text comes to the reader instead. Touching it stops it at once, and
// Notes is then exactly Notes: long-press to select, highlight, open a
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
//     selected.
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
// Speed is in words a minute, which is how reading speed is measured everywhere
// else in the app (src/stats/reading-speed.js), and the default IS the reader's
// measured speed once there is one. It is turned into pixels from how densely
// the text on screen packs words — re-measured every 750ms, never per frame,
// smoothed, and held to a band around what the type size predicts, so a picture
// or a code block does not send the text racing past.
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
import { liveNotesWordsLeft } from "../stats/reading-progress.js?v=__BUILD__";
import { readSpeedModel, speedFor, speedMeasured } from "../stats/reading-speed.js?v=__BUILD__";
import { isAdjustHandlesOpen } from "../ui/adjust-handles.js?v=__BUILD__";
import { isFocusModeActive, setFocusMode } from "../ui/chrome.js?v=__BUILD__";
import { anyModalOpen } from "../ui/overlays.js?v=__BUILD__";
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
  TELEPROMPTER_AUTO_RESUMES, TELEPROMPTER_COUNTDOWNS, TELEPROMPTER_FONTS, TELEPROMPTER_RANGES,
  closeTeleprompterSheet, ensureTeleprompterPanel, isTeleprompterSheetOpen, paintTeleprompterPanel,
  placeTeleprompterBand, removeTeleprompterPanel, teleprompterPanelContains, toggleTeleprompterSheet, wakeTeleprompterBar
} from "./teleprompter-panel.js?v=__BUILD__";
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
  wake: true
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
// "ended" at the foot of the note.
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
    pxPerSecond: teleprompterSession.wordsPerPx ? teleprompterSession.wpm / 60 / teleprompterSession.wordsPerPx : 0,
    wordsPerPx: teleprompterSession.wordsPerPx,
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
}

// ── The type, the runway and the band ───────────────────────────────────────

function applyTeleprompterType(view) {
  const { settings } = teleprompterSession;
  view.style.setProperty("--notes-font-size", `${teleprompterSession.fontSize}px`);
  view.style.setProperty("--notes-line-height", String(settings.lineHeight));
  view.style.setProperty("--notes-max-width", `${settings.width}%`);
  if (TELEPROMPTER_FONT_STACKS[settings.font]) view.style.setProperty("--notes-font-family", TELEPROMPTER_FONT_STACKS[settings.font]);
  else view.style.removeProperty("--notes-font-family");
  // Type of a different size packs words differently; measure it afresh.
  teleprompterSession.wordsPerPx = 0;
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
}

// ── Words a minute into pixels a second ─────────────────────────────────────

const TELEPROMPTER_TEXT_BLOCKS = "p, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6";

// The block after this one in reading order, across a chunk's edge.
function nextReadingBlock(node, view) {
  if (node.nextElementSibling) return node.nextElementSibling;
  const parent = node.parentElement;
  if (!parent || parent === view || !parent.classList.contains(NOTES_CHUNK_CLASS)) return null;
  let chunk = parent.nextElementSibling;
  while (chunk && !chunk.firstElementChild) chunk = chunk.nextElementSibling;
  return chunk?.firstElementChild || null;
}

// Words per pixel of the text on screen: prose only — a picture or a table has
// height and no words, and counting it would make the text after it race —
// with each block's share of the gap to the next counted as its own, as the
// progress row's measure does (visibleWordsPerPx in src/stats/reading-progress.js).
function measureTeleprompterDensity(view) {
  const box = view.getBoundingClientRect();
  const bottom = box.top + view.clientHeight;
  let block = notesBlockAtReadingLineGeometric(box.top + 1);
  let words = 0;
  let height = 0;
  let width = 0;
  for (let i = 0; block && i < 60; i += 1) {
    const rect = block.getBoundingClientRect();
    if (rect.top > bottom) break;
    const next = nextReadingBlock(block, view);
    if (rect.height > 0 && block.matches(TELEPROMPTER_TEXT_BLOCKS)) {
      const slotBottom = next ? Math.max(rect.bottom, next.getBoundingClientRect().top) : rect.bottom;
      words += (block.textContent.match(/\S+/g) || []).length;
      height += slotBottom - rect.top;
      width = width || block.clientWidth;
    }
    block = next;
  }
  // What the type predicts: a word is about six characters with its space, a
  // character about half an em; plus some paragraph spacing.
  const style = getComputedStyle(view);
  const fontPx = parseFloat(style.fontSize) || 16;
  const line = teleprompterLineHeight(view);
  const wordsPerLine = Math.max(3, (width || view.clientWidth) / (fontPx * 0.5 * 6));
  const predicted = wordsPerLine / (line * 1.15);
  const measured = words && height > line * 2 ? words / height : 0;
  const sample = measured ? Math.min(predicted * 2, Math.max(predicted * 0.5, measured)) : (teleprompterSession.wordsPerPx || predicted);
  teleprompterSession.wordsPerPx = teleprompterSession.wordsPerPx ? teleprompterSession.wordsPerPx + 0.3 * (sample - teleprompterSession.wordsPerPx) : sample;
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
    setNotesAutoScrolling(false);
    watchTeleprompter();
    return;
  }
  const dt = teleprompterSession.lastFrameAt ? Math.min(100, now - teleprompterSession.lastFrameAt) / 1000 : 0;
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
    setNotesAutoScrolling(false);
    resyncPosition();
    scheduleTeleprompterFrame();
    return;
  }
  if (!teleprompterSession.wordsPerPx || now - teleprompterSession.measuredAt > DENSITY_MS) {
    measureTeleprompterDensity(view);
    teleprompterSession.measuredAt = now;
  }
  if (Math.abs(view.scrollTop - teleprompterSession.lastWritten) > 1.5) teleprompterSession.pos = view.scrollTop;
  const max = Math.max(0, view.scrollHeight - view.clientHeight);
  const pxPerSecond = teleprompterSession.wpm / 60 / teleprompterSession.wordsPerPx;
  teleprompterSession.pos = Math.min(max, teleprompterSession.pos + pxPerSecond * teleprompterSession.ease * dt);
  setNotesAutoScrolling(true);
  markProgrammaticNotesScroll();
  view.scrollTop = teleprompterSession.pos;
  teleprompterSession.lastWritten = view.scrollTop;
  if (teleprompterSession.phase === "playing" && teleprompterSession.pos >= max - 0.5 && !lastSpanPending(view)) {
    finishTeleprompter();
    return;
  }
  scheduleTeleprompterFrame();
}

// ── The screen, kept on ─────────────────────────────────────────────────────
//
// A phone dims after thirty seconds without a touch, and a teleprompter is
// thirty seconds without a touch by design.

async function holdScreenAwake() {
  if (!teleprompterSession || !teleprompterSession.settings.wake || teleprompterSession.wakeLock || teleprompterSession.wakeRequested) return;
  if (typeof navigator === "undefined" || !navigator.wakeLock?.request) return;
  const owner = teleprompterSession;
  owner.wakeRequested = true;
  try {
    const lock = await navigator.wakeLock.request("screen");
    owner.wakeRequested = false;
    if (teleprompterSession !== owner || owner.phase !== "playing" || !owner.settings.wake) {
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
  ended: "End of the notes"
};

function timeLeftText() {
  const words = liveNotesWordsLeft();
  if (!(words > 0) || !teleprompterSession.wpm) return "";
  return `≈ ${formatDuration((words / teleprompterSession.wpm) * 60000, { short: true })} left`;
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
    measuredAt: 0,
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
    teleprompterSession.resizeObserver = new ResizeObserver(() => relayoutTeleprompter({ compensate: true }));
    teleprompterSession.resizeObserver.observe(view);
  }
  teleprompterSession.watchTimer = setInterval(watchTeleprompter, WATCH_MS);
  paintTeleprompterToggles();
  beginTeleprompterCountdown();
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
  if (!teleprompterSession) return;
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
  if (!teleprompterSession) return;
  if (teleprompterSession.phase === "playing") pauseTeleprompter("button");
  else resumeTeleprompter();
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
  if (state.viewMode !== "notes" || !isDisplayed(el.notesView)) {
    pauseTeleprompter("away");
    return;
  }
  if (document.hidden) {
    pauseTeleprompter("hidden");
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
      if (performance.now() - teleprompterSession.capturedAt >= PLAY_CAPTURE_MS) saveTeleprompterPlace();
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

function nudgeTeleprompter(lines) {
  const view = el.notesView;
  if (!teleprompterSession || !view) return;
  markProgrammaticNotesScroll();
  view.scrollTop = Math.max(0, view.scrollTop + lines * teleprompterLineHeight(view));
  resyncPosition();
  if (teleprompterSession.phase === "ended" && lines < 0) {
    teleprompterSession.phase = "paused";
    teleprompterSession.pauseReason = "button";
    paintTeleprompter();
  }
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
  switch (event.key) {
    case " ":
    case "Spacebar":
      // A focused button, link or cloze takes its own Space.
      if (target?.closest?.("button, a, .cloze, [role='button']")) return;
      act(togglePlayTeleprompter);
      return;
    case "ArrowUp": act(() => changeTeleprompterSpeed(TELEPROMPTER_RANGES.wpm.step)); return;
    case "ArrowDown": act(() => changeTeleprompterSpeed(-TELEPROMPTER_RANGES.wpm.step)); return;
    case "ArrowLeft": act(() => nudgeTeleprompter(-2)); return;
    case "ArrowRight": act(() => nudgeTeleprompter(2)); return;
    case "+":
    case "=": act(() => changeTeleprompterSize(2)); return;
    case "-":
    case "_": act(() => changeTeleprompterSize(-2)); return;
    // The browser scrolls for these; the reader has taken the scroller back.
    case "PageUp":
    case "PageDown":
    case "Home":
    case "End":
      if (teleprompterSession.phase === "playing" || teleprompterSession.phase === "countdown") pauseTeleprompter("reader");
      return;
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
