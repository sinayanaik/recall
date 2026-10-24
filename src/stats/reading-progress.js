// How far through the open Notes or PDF the reader is, and how long the rest
// will take — the Kindle line at the foot of the page: "42% · Ch 3/12 · 8 min
// left in chapter · 1 h 10 min left".
//
// Everything here is worked out on this device from things the reader already
// has: the PDF's page geometry and outline, and the note's own markdown. The
// position is filed into this device's stats (src/stats/reading-stats-store.js)
// for Home and for the other devices; the time left is divided by THIS device's
// reading speed (src/stats/reading-speed.js) and recomputed on every page move
// and every heartbeat, so it settles as the reader reads.
//
// Units: a PDF is measured in pages (fractional — "page 12, three quarters
// down" is 11.75), a note in words. A chapter is the shallowest heading level
// the file uses more than once: a book's outline usually opens with one entry
// for the book itself, and counting that as "Ch 1/1" would say nothing.

import { el, isDisplayed } from "../core/dom.js?v=__BUILD__";
import { documentAutoScrolling, notesAutoScrolling } from "../core/gesture.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { documentOutlineEntries } from "../documents/pdf-outline.js?v=__BUILD__";
import { deckPdfById, PDF_PRIMARY_ID } from "../documents/pdf-multi.js?v=__BUILD__";
import {
  currentDocumentPage, currentDocumentRatio, currentPdfPageCount, documentSurfaceHidden, openDocumentPdfId, openDocumentSlot
} from "../documents/pdf-view.js?v=__BUILD__";
import { headingIndexFor } from "../notes/chapters.js?v=__BUILD__";
import { isNotesPaged } from "../notes/paged-view.js?v=__BUILD__";
import { readStoredReadingPosition } from "../notes/reading-position.js?v=__BUILD__";
import {
  currentDeckKey, currentReadingAnchor, currentReadingAnchorDeckKey, notesBlockAtReadingLineGeometric
} from "../notes/scroll-anchor.js?v=__BUILD__";
import { formatDuration } from "./combine.js?v=__BUILD__";
import {
  buildWordIndex, calibrateWordsPerPx, chapterProgress, interpolateNotesWords, isReadingJump, pickChapterLevel, wordsBeforeOffset
} from "./reading-math.js?v=__BUILD__";
import { readReadingStats, recordPartProgress, statsFileKey } from "./reading-stats-store.js?v=__BUILD__";
import {
  estimateRemainingMs, readSpeedModel, recordSpeedSample, speedMeasured
} from "./reading-speed.js?v=__BUILD__";

// A speed sample is taken once the reader has moved forward AND this much
// active time has gone by; a window that never moves is abandoned after the
// longer one (the file left open while doing something else).
export const SPEED_WINDOW_MS = 15 * 1000;
export const SPEED_WINDOW_MAX_MS = 30 * 60 * 1000;

// Backward wobble that is still the same place: a re-measured anchor, a page
// that settled a few pixels up.
const BACKWARD_SLACK = { pdf: 0.05, notes: 40 };

// Positions go into the stats store at most this often while scrolling; leaving
// the file writes the last one straight away.
const PROGRESS_COMMIT_MS = 2000;

// ── Words in a note ─────────────────────────────────────────────────────────
// The index itself is built in ./reading-math.js; this keeps the one for the
// note on screen.

let wordIndexCache = null;

function notesWordIndex(source) {
  if (wordIndexCache && wordIndexCache.text === source) return wordIndexCache;
  wordIndexCache = buildWordIndex(source);
  return wordIndexCache;
}

let notesChapterCache = { text: null, chapters: [] };

function notesReadingChapters(source, index) {
  if (notesChapterCache.text === source) return notesChapterCache.chapters;
  const headings = headingIndexFor(source).map((heading) => ({
    start: wordsBeforeOffset(index, heading.start),
    level: heading.level,
    title: heading.title
  }));
  notesChapterCache = { text: source, chapters: pickChapterLevel(headings) };
  return notesChapterCache.chapters;
}

let pdfChapterCache = { entries: null, resolved: -1, chapters: [] };

function pdfChapters() {
  const entries = documentOutlineEntries();
  if (!entries?.length) return [];
  // The outline's tail resolves its pages in the background, in place — so the
  // count of resolved entries is part of what the cache is keyed on.
  let resolved = 0;
  for (const entry of entries) if (entry.page > 0) resolved += 1;
  if (pdfChapterCache.entries === entries && pdfChapterCache.resolved === resolved) return pdfChapterCache.chapters;
  const chapters = pickChapterLevel(entries
    .filter((entry) => entry.page > 0)
    .map((entry) => ({ start: entry.page - 1, level: entry.depth || 0, title: entry.title })));
  pdfChapterCache = { entries, resolved, chapters };
  return chapters;
}

// ── The open reading surface ────────────────────────────────────────────────

// What is on screen: { fileKey, ids, title, partKey, kind, name, pos, total,
// pct, furthest, chapter }. Null when nothing readable is open.
let liveReading = null;
const furthestByPart = new Map();

function openFileIds() {
  if (state.folderDeck) return null;
  const ids = { deckId: state.deckId || null, localDeckId: state.localDeckId || null };
  return statsFileKey(ids) ? ids : null;
}

function furthestFor(key, pos, stored) {
  const known = Math.max(furthestByPart.get(key) || 0, stored || 0, pos);
  furthestByPart.set(key, known);
  if (furthestByPart.size > 64) furthestByPart.delete(furthestByPart.keys().next().value);
  return known;
}

function scrolledToEnd(view) {
  return Boolean(view) && view.scrollHeight > 0 && view.scrollTop + view.clientHeight >= view.scrollHeight - 4;
}

// Neither measure reads a surface that is not on screen. Home hides the whole
// study surface with display:none and leaves the file open, and inside it every
// offset reads 0: the PDF used to measure as "on the last page" and the note as
// "at the top", and the heartbeat filed that as how far the reader had got. A
// null here makes adopt() write down the last reading taken ON screen and stop;
// the first beat after the reader is back measures again.
function measureDocument() {
  if (state.viewMode !== "document" || openDocumentSlot() !== "doc") return null;
  if (documentSurfaceHidden()) return null;
  const ids = openFileIds();
  const pages = currentPdfPageCount();
  if (!ids || !pages) return null;
  const page = currentDocumentPage();
  const ratio = Math.min(1, Math.max(0, currentDocumentRatio() || 0));
  let pos = Math.min(pages, Math.max(0, page - 1 + ratio));
  if (page >= pages && scrolledToEnd(el.documentView)) pos = pages;
  const pdfId = openDocumentPdfId() || PDF_PRIMARY_ID;
  return {
    ids,
    kind: "pdf",
    partKey: `doc:${pdfId}`,
    name: deckPdfById(state.meta, pdfId)?.name || "",
    page,
    pos,
    total: pages,
    chapters: pdfChapters()
  };
}

function notesOffsetNow() {
  const key = currentDeckKey();
  if (currentReadingAnchor && currentReadingAnchorDeckKey === key && Number.isFinite(currentReadingAnchor.offset)) {
    return currentReadingAnchor.offset;
  }
  const stored = readStoredReadingPosition(key);
  if (stored && Number.isFinite(stored.offset)) return stored.offset;
  if (isDisplayed(el.notesView) && el.notesView.scrollTop < 8) return 0;
  return null;
}

// The last exact readings of the note on screen, for following the scroll in
// between them (interpolateNotesWords). Belongs to one note body: a different
// deck, or an edit, starts again from the next exact reading.
let notesCalibration = null;

function notesAverageWordsPerPx(view, total) {
  const range = view ? view.scrollHeight - view.clientHeight : 0;
  return range > 0 ? total / range : 0;
}

// How densely the text on screen packs words, measured off the blocks from
// the reading line down: their words over their height. The whole note's
// average (total words over scroll height) is a poor guide on a long note,
// where the height of everything not yet laid out is an estimate — and the
// next screen reads like this one far more than like the book's average.
// Taken once per exact reading, never while scrolling.
function visibleWordsPerPx(view) {
  let block = notesBlockAtReadingLineGeometric();
  if (!block) return 0;
  // From the first block's top to the last one's bottom, so the gaps between
  // paragraphs count as the pixels they are: block boxes alone leave out the
  // margins, and a rate taken off them runs ahead of the reader.
  const top = block.getBoundingClientRect().top;
  let bottom = top;
  let words = 0;
  for (let i = 0; block && i < 40 && bottom - top < view.clientHeight * 1.5; i += 1) {
    const rect = block.getBoundingClientRect();
    if (rect.height > 0) {
      bottom = Math.max(bottom, rect.bottom);
      words += (block.textContent.match(/\S+/g) || []).length;
    }
    block = block.nextElementSibling;
  }
  const height = bottom - top;
  return height >= view.clientHeight / 2 && words > 0 ? words / height : 0;
}

// Folds an exact reading in: where it was taken and how many words in, plus
// the words-per-pixel to follow the scroll at until the next one — what is on
// screen, or failing that what the last two exact readings measured.
function calibrateNotes(key, source, words, total) {
  const view = el.notesView;
  if (!isDisplayed(view) || isNotesPaged()) {
    notesCalibration = null;
    return;
  }
  const next = { key, source, scrollTop: view.scrollTop, words };
  const previous = notesCalibration && notesCalibration.key === key && notesCalibration.source === source ? notesCalibration : null;
  const average = notesAverageWordsPerPx(view, total);
  let visible = 0;
  try { visible = visibleWordsPerPx(view); } catch { visible = 0; }
  const measured = calibrateWordsPerPx(previous, next, average);
  next.wordsPerPx = visible || measured || previous?.wordsPerPx || 0;
  notesCalibration = next;
}

// Where in the note the reader is, in words. `exactOffset` is a captured
// anchor; without one, the scroll is followed from the last exact reading,
// which is what keeps the line moving on every frame instead of waiting for the
// scroll to settle.
function measureNotes(exactOffset = null) {
  if (state.viewMode !== "notes" || !isDisplayed(el.notesStage)) return null;
  const ids = openFileIds();
  const source = state.notes || "";
  if (!ids || !source.trim()) return null;
  const index = notesWordIndex(source);
  if (!index.total) return null;
  const key = currentDeckKey();
  const view = el.notesView;
  // Raw mode hides the rendered note and puts the editor on screen: its
  // scrollTop reads 0 there, which is not the reader's place, so the place is
  // the last captured anchor until it is back.
  const following = isDisplayed(view);
  let pos = null;
  if (exactOffset != null) {
    pos = Math.min(index.total, wordsBeforeOffset(index, exactOffset));
    calibrateNotes(key, source, pos, index.total);
  } else if (following && notesCalibration && notesCalibration.key === key && notesCalibration.source === source && !isNotesPaged()) {
    pos = interpolateNotesWords(notesCalibration, view.scrollTop, index.total, notesAverageWordsPerPx(view, index.total));
  } else {
    const offset = notesOffsetNow();
    if (offset == null) return null;
    pos = Math.min(index.total, wordsBeforeOffset(index, offset));
  }
  if (following && !isNotesPaged() && scrolledToEnd(view)) pos = index.total;
  return { ids, kind: "notes", partKey: "notes", name: "", page: 0, pos, total: index.total, chapters: notesReadingChapters(source, index) };
}

function settleReading(measured) {
  if (!measured) return null;
  const fileKey = statsFileKey(measured.ids);
  const partId = `${fileKey}|${measured.partKey}`;
  // How far this device had got in an earlier session, so "chapters done"
  // does not start again from where the reader happens to open the file.
  const storedPct = Number(readReadingStats().files[fileKey]?.parts?.[measured.partKey]?.furthestPct) || 0;
  const furthest = furthestFor(partId, measured.pos, storedPct * measured.total);
  return {
    ...measured,
    fileKey,
    partId,
    title: state.deckTitle || "",
    pct: measured.total > 0 ? Math.min(1, measured.pos / measured.total) : 0,
    furthest,
    chapter: chapterProgress(measured.chapters, measured.pos, furthest, measured.total)
  };
}

// ── Speed sampling ──────────────────────────────────────────────────────────

let speedWindow = null;

function resetSpeedWindow(reading, now = Date.now()) {
  speedWindow = reading
    ? { partId: reading.partId, kind: reading.kind, start: reading.pos, last: reading.pos, ms: 0, markAt: now, markPos: reading.pos }
    : null;
}

// Every position, every frame. A move that is too far, or too FAST over the
// last quarter second (isReadingJump), is the reader travelling rather than
// reading — so the window starts again from where they landed.
function observePosition(reading, now = Date.now()) {
  // The teleprompter is moving a note at the speed the reader SET, which is
  // not a measurement of the speed they read at — and that measurement is the
  // teleprompter's own default speed, so learning from it would feed itself.
  // The window starts again from wherever it stops.
  if ((reading.kind === "notes" && notesAutoScrolling()) || (reading.kind === "pdf" && documentAutoScrolling())) {
    resetSpeedWindow(reading, now);
    return;
  }
  if (!speedWindow || speedWindow.partId !== reading.partId) {
    resetSpeedWindow(reading, now);
    return;
  }
  const backward = reading.pos - speedWindow.last < -BACKWARD_SLACK[reading.kind];
  const dt = now - speedWindow.markAt;
  if (backward || isReadingJump(reading.kind, reading.pos - speedWindow.markPos, dt)) {
    resetSpeedWindow(reading, now);
    return;
  }
  if (dt >= 250) {
    speedWindow.markAt = now;
    speedWindow.markPos = reading.pos;
  }
  speedWindow.last = Math.max(speedWindow.last, reading.pos);
}

function feedSpeedWindow(activeMs) {
  if (!speedWindow || !liveReading || speedWindow.partId !== liveReading.partId) return;
  speedWindow.ms += activeMs;
  const moved = speedWindow.last - speedWindow.start;
  if (moved > 0 && speedWindow.ms >= SPEED_WINDOW_MS) {
    recordSpeedSample({ kind: speedWindow.kind, fileRateKey: speedWindow.partId, units: moved, ms: speedWindow.ms });
    speedWindow.start = speedWindow.last;
    speedWindow.ms = 0;
  } else if (speedWindow.ms > SPEED_WINDOW_MAX_MS) {
    speedWindow.start = speedWindow.last;
    speedWindow.ms = 0;
  }
}

// ── Into the stats store ────────────────────────────────────────────────────

let commitTimer = 0;
let committedPct = -1;

function commitProgress() {
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = 0;
  const reading = liveReading;
  if (!reading) return;
  const fields = {
    pct: Number(reading.pct.toFixed(4)),
    furthestPct: Number(Math.min(1, reading.furthest / reading.total).toFixed(4)),
    [reading.kind === "pdf" ? "pages" : "words"]: reading.total
  };
  if (reading.kind === "pdf") {
    fields.page = reading.page;
    if (reading.name) fields.name = reading.name;
  }
  if (reading.chapter) {
    fields.chTotal = reading.chapter.chTotal;
    fields.chDone = reading.chapter.chDone;
    fields.chIndex = reading.chapter.chIndex;
    fields.chTitle = reading.chapter.chTitle.slice(0, 120);
  }
  committedPct = reading.pct;
  recordPartProgress(reading.ids, reading.title, reading.partKey, fields);
}

function scheduleProgressCommit() {
  if (commitTimer || !liveReading) return;
  if (Math.abs(liveReading.pct - committedPct) < 0.0005) return;
  commitTimer = setTimeout(commitProgress, PROGRESS_COMMIT_MS);
}

// ── The line at the foot of the page ────────────────────────────────────────

const strips = new Map();

// Off until the reader asks for it — ⋯ → Show progress, in Notes or a PDF.
// Progress is measured and kept either way; this is only whether the row is on
// screen. Per device, like the PDF's page notes.
export const READING_PROGRESS_SHOWN_KEY = "recall:readingProgressShown";

let progressShown = null;

export function readingProgressShown() {
  if (progressShown === null) {
    try { progressShown = localStorage.getItem(READING_PROGRESS_SHOWN_KEY) === "on"; } catch { progressShown = false; }
  }
  return progressShown;
}

// The two switches that say it: a row in each ⋯ menu.
export function paintReadingProgressToggles() {
  const on = readingProgressShown();
  const buttons = [
    document.getElementById("readingProgressNotesBtn"),
    el.documentMoreMenu?.querySelector('[data-document-action="reading-progress"]')
  ];
  for (const button of buttons) {
    if (!button) continue;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    button.title = on ? "Hide the progress row at the foot of the page" : "Show how far you are, the chapter and the time left, in one row at the foot of the page";
  }
}

export function setReadingProgressShown(on) {
  progressShown = Boolean(on);
  try { localStorage.setItem(READING_PROGRESS_SHOWN_KEY, progressShown ? "on" : "off"); } catch { /* this session only */ }
  paintReadingProgressToggles();
  if (progressShown) tickReadingProgress(0);
  schedulePaint();
}

export function toggleReadingProgressShown() {
  setReadingProgressShown(!readingProgressShown());
}

function stripFor(stage) {
  if (!stage) return null;
  let strip = strips.get(stage);
  if (strip) return strip;
  const root = document.createElement("div");
  root.className = "reading-progress";
  root.hidden = true;
  const bar = document.createElement("span");
  bar.className = "reading-progress-bar";
  const fill = document.createElement("span");
  fill.className = "reading-progress-fill";
  bar.append(fill);
  const label = document.createElement("span");
  label.className = "reading-progress-label";
  root.setAttribute("aria-label", "Reading progress");
  const pct = document.createElement("span");
  pct.className = "reading-progress-pct";
  const chapter = document.createElement("span");
  chapter.className = "reading-progress-chapter";
  const chapterLeft = document.createElement("span");
  chapterLeft.className = "reading-progress-chapter-left";
  const left = document.createElement("span");
  left.className = "reading-progress-left";
  label.append(pct, chapter, chapterLeft, left);
  root.append(bar, label);
  stage.append(root);
  strip = { root, label, fill, pct, chapter, chapterLeft, left, text: "" };
  strips.set(stage, strip);
  return strip;
}

// The estimate for the open part, on this device's speed.
export function readingTimeLeft(reading = liveReading) {
  if (!reading) return null;
  const model = readSpeedModel();
  const remaining = Math.max(0, reading.total - reading.pos);
  return {
    leftMs: estimateRemainingMs(model, reading.kind, reading.partId, remaining),
    chapterLeftMs: reading.chapter ? estimateRemainingMs(model, reading.kind, reading.partId, reading.chapter.chLeftUnits) : 0,
    measured: speedMeasured(model, reading.kind)
  };
}

// Words between the reading line and the end of the note on screen, or null
// when the open surface is not a note. For the teleprompter's "time left at
// this speed", which divides by the speed the reader set rather than the one
// measured.
export function liveNotesWordsLeft() {
  if (liveReading?.kind !== "notes") return null;
  return Math.max(0, liveReading.total - liveReading.pos);
}

// "32.4%" — a tenth of a percent, so the number moves while the reader does.
export function formatReadingPct(pct) {
  if (pct >= 0.9995) return "100%";
  return `${(Math.floor(Math.max(0, pct) * 1000) / 10).toFixed(1)}%`;
}

function paintStrip(stage, reading) {
  if (!stage) return;
  const shown = Boolean(reading) && readingProgressShown();
  stage.classList.toggle("has-reading-progress", shown);
  // Not created until it is first wanted: a reader who never turns it on has
  // nothing extra in the stage at all.
  const strip = shown ? stripFor(stage) : strips.get(stage);
  if (!strip) return;
  if (!shown) {
    strip.root.hidden = true;
    return;
  }
  const time = readingTimeLeft(reading);
  const done = reading.pct >= 0.995;
  const pctText = formatReadingPct(reading.pct);
  const ch = reading.chapter;
  const chapterText = ch && ch.chTotal > 1 && ch.chIndex >= 0 ? `Ch ${ch.chIndex + 1}/${ch.chTotal}` : "";
  const chapterLeftText = chapterText && !done && time.chapterLeftMs > 0 ? `${formatDuration(time.chapterLeftMs, { short: true })} left in chapter` : "";
  const leftText = done ? "Finished" : `${formatDuration(time.leftMs, { short: true })} left`;
  const text = [pctText, chapterText, chapterLeftText, leftText].join("|");
  strip.root.hidden = false;
  strip.fill.style.width = `${(reading.pct * 100).toFixed(2)}%`;
  if (text === strip.text) return;
  strip.text = text;
  strip.pct.textContent = pctText;
  strip.chapter.textContent = chapterText;
  strip.chapter.hidden = !chapterText;
  strip.chapterLeft.textContent = chapterLeftText;
  strip.chapterLeft.hidden = !chapterLeftText;
  strip.left.textContent = leftText;
  const where = reading.kind === "pdf" ? `Page ${reading.page} of ${reading.total}` : `${reading.total.toLocaleString()} words`;
  const chapterLine = ch && ch.chIndex >= 0 && ch.chTitle ? ` · ${ch.chTitle}` : "";
  const chaptersDone = ch && ch.chTotal > 1 ? ` · ${ch.chDone} of ${ch.chTotal} chapters done` : "";
  const basis = time.measured ? "your reading speed on this device" : "a typical reading speed, until this device has measured yours";
  strip.label.title = `${pctText} read · ${where}${chapterLine}${chaptersDone}. Time left is estimated from ${basis}.`;
}

let paintFrame = 0;

function schedulePaint() {
  if (paintFrame) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = 0;
    paintStrip(el.documentStage, liveReading?.kind === "pdf" ? liveReading : null);
    paintStrip(el.notesStage, liveReading?.kind === "notes" ? liveReading : null);
  });
}

function adopt(reading) {
  if (liveReading && (!reading || reading.partId !== liveReading.partId)) commitProgress();
  liveReading = reading;
  if (reading) {
    observePosition(reading);
    scheduleProgressCommit();
  }
  schedulePaint();
}

// ── Entry points ────────────────────────────────────────────────────────────

// Every page move in the PDF reader (updatePageIndicator). Once a frame while
// scrolling, so it only reads geometry the page indicator has just read.
export function noteDocumentProgress() {
  if (state.viewMode !== "document") return;
  adopt(settleReading(measureDocument()));
}

// Every scroll frame in the note (src/main.js's #notesView listener): follow
// the scroll from the last exact reading. One scrollTop read; no layout.
let notesScrollFrame = 0;

export function noteNotesScroll() {
  if (notesScrollFrame) return;
  notesScrollFrame = requestAnimationFrame(() => {
    notesScrollFrame = 0;
    if (state.viewMode !== "notes") return;
    adopt(settleReading(measureNotes()));
  });
}

// A reading anchor was just captured in the note (src/notes/scroll-anchor.js):
// the exact place, which corrects whatever the scroll-following estimated.
export function noteNotesProgress(anchor, key) {
  if (state.viewMode !== "notes" || key !== currentDeckKey()) return;
  if (!Number.isFinite(anchor?.offset)) return;
  const reading = settleReading(measureNotes(anchor.offset));
  adopt(reading);
  exactNotesReading = reading && isDisplayed(el.notesView) && !isNotesPaged()
    ? { key, source: state.notes || "", wordsLeft: Math.max(0, reading.total - reading.pos), scrollTop: el.notesView.scrollTop, at: performance.now() }
    : null;
}

// The last EXACT reading of the note on screen — a captured anchor, never the
// scroll-following estimate between two — with the scrollTop it was taken at.
// For the teleprompter's time left, which learns from these how many of the
// note's words go to a pixel at its own type (src/notes/teleprompter.js).
let exactNotesReading = null;

export function lastExactNotesReading() {
  const reading = exactNotesReading;
  if (!reading || reading.key !== currentDeckKey() || reading.source !== (state.notes || "")) return null;
  return reading;
}

// The heartbeat (src/stats/activity.js): re-measure, count the active time
// toward the reading speed, and recompute the time left.
export function tickReadingProgress(activeMs) {
  const reading = state.viewMode === "document" ? settleReading(measureDocument())
    : state.viewMode === "notes" ? settleReading(measureNotes())
      : null;
  adopt(reading);
  if (reading && activeMs > 0) feedSpeedWindow(activeMs);
  schedulePaint();
}

// Leaving a part — another tab, another file, the app going away. Whatever was
// measured last is written now, and the speed window closes: the minutes spent
// elsewhere are not reading.
export function leaveReadingSurface() {
  commitProgress();
  resetSpeedWindow(null);
  liveReading = null;
  schedulePaint();
}

export function flushReadingProgress() {
  commitProgress();
}

// The Notes ⋯ row is wired here; the PDF ⋯ row goes through that menu's own
// [data-document-action] handler in src/main.js.
export function initReadingProgressToggles() {
  document.getElementById("readingProgressNotesBtn")?.addEventListener("click", toggleReadingProgressShown);
  paintReadingProgressToggles();
}
