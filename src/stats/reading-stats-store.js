// This device's own reading stats: active time and how far through each file's
// Notes and PDFs the reader has got.
//
// Measured and stored here first. src/stats/stats-sync.js then puts the whole
// record up as THIS device's row and brings the others' rows down, and
// src/stats/combine.js folds them together for Home. A device only ever writes
// its own record, so two devices reading at once can never overwrite each
// other's minutes.
//
// One localStorage key, written on a trailing 30-second debounce and flushed
// synchronously on pagehide and when the app is hidden — the same shape as the
// reading-position store (src/notes/reading-position.js), for the same reason:
// a phone kills a backgrounded app without asking.

import { deviceId, deviceLabel } from "../sync/device.js?v=__BUILD__";
import { localDayKey } from "./combine.js?v=__BUILD__";
import { forgetSpeedModel } from "./reading-speed.js?v=__BUILD__";

export const READING_STATS_KEY = "recall:reading-stats-v1";
export const READING_STATS_DEVICES_KEY = "recall:reading-stats-devices-v1";

export const READING_STATS_SAVE_MS = 30 * 1000;
export const READING_STATS_MAX_FILES = 500;
export const READING_STATS_MAX_DAYS = 400;

// One heartbeat never adds more than this, whatever the clock says: a laptop
// that slept with the app open wakes to one long gap, not hours of reading.
export const READING_STATS_MAX_TICK_MS = 10 * 1000;

export function emptyReadingStats() {
  return { v: 1, deviceId: "", label: "", updatedAt: 0, pushedAt: 0, totalMs: 0, days: {}, files: {} };
}

let readingStatsDoc = null;
let readingStatsSaveTimer = 0;
const listeners = new Set();

export function onReadingStatsChanged(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announceReadingStats(kind) {
  for (const listener of listeners) {
    try {
      listener(kind);
    } catch (error) {
      console.warn("A reading-stats listener failed", error);
    }
  }
}

export function readReadingStats() {
  if (readingStatsDoc) return readingStatsDoc;
  readingStatsDoc = emptyReadingStats();
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_STATS_KEY) || "null");
    if (parsed && typeof parsed === "object") {
      readingStatsDoc = { ...emptyReadingStats(), ...parsed, days: parsed.days || {}, files: parsed.files || {} };
    }
  } catch { /* unreadable or blocked: start empty */ }
  return readingStatsDoc;
}

// Has anything changed since the last push?
export function readingStatsDirty() {
  const current = readReadingStats();
  return (current.updatedAt || 0) > (current.pushedAt || 0);
}

export function markReadingStatsPushed(at) {
  const current = readReadingStats();
  current.pushedAt = Math.max(current.pushedAt || 0, at || 0);
  writeReadingStatsNow();
}

// The key a file's stats are filed under: its cloud id, which every device
// shares, or — until it has one — this device's local id.
export function statsFileKey(ids) {
  if (ids?.deckId) return String(ids.deckId);
  if (ids?.localDeckId) return `local:${ids.localDeckId}`;
  return null;
}

// Drops the oldest days and files once there are too many. Pure on `doc`.
export function pruneReadingStats(doc, now = Date.now()) {
  const days = Object.keys(doc.days || {}).sort();
  const cutoff = localDayKey(now - READING_STATS_MAX_DAYS * 24 * 60 * 60 * 1000);
  for (const day of days) {
    if (day < cutoff) delete doc.days[day];
  }
  const keys = Object.keys(doc.files || {});
  if (keys.length > READING_STATS_MAX_FILES) {
    keys.sort((a, b) => (doc.files[a].at || 0) - (doc.files[b].at || 0));
    for (const key of keys.slice(0, keys.length - READING_STATS_MAX_FILES)) delete doc.files[key];
  }
  return doc;
}

// The entry for one file, created on first use. A file that has just been
// given a cloud id has its local-keyed entry moved across, so the minutes read
// before its first sync are not stranded under a key no other device knows.
export function fileStatsEntry(doc, ids, title = "") {
  const key = statsFileKey(ids);
  if (!key) return null;
  if (ids.deckId && ids.localDeckId) {
    const localKey = `local:${ids.localDeckId}`;
    const stranded = doc.files[localKey];
    if (stranded) {
      delete doc.files[localKey];
      const existing = doc.files[key];
      doc.files[key] = existing ? mergeFileEntries(existing, stranded) : stranded;
    }
  }
  const entry = doc.files[key] || (doc.files[key] = { deckId: null, localId: null, title: "", at: 0, parts: {} });
  if (ids.deckId) entry.deckId = String(ids.deckId);
  if (ids.localDeckId) entry.localId = String(ids.localDeckId);
  if (title) entry.title = String(title).slice(0, 200);
  return entry;
}

function mergeFileEntries(a, b) {
  const parts = { ...a.parts };
  for (const [key, part] of Object.entries(b.parts || {})) {
    const other = parts[key];
    if (!other) { parts[key] = part; continue; }
    const newer = (part.at || 0) > (other.at || 0) ? part : other;
    parts[key] = {
      ...newer,
      ms: (other.ms || 0) + (part.ms || 0),
      furthestPct: Math.max(other.furthestPct || 0, part.furthestPct || 0)
    };
  }
  return { ...a, at: Math.max(a.at || 0, b.at || 0), parts };
}

// Adds active time. `where` is { ids, title, part } for time spent in a file,
// or null for time on Home and in panels with no file open. Pure on `doc`.
export function addActiveTime(doc, ms, where, now = Date.now()) {
  const amount = Math.max(0, Math.min(READING_STATS_MAX_TICK_MS, Number(ms) || 0));
  if (!amount) return false;
  doc.totalMs = (doc.totalMs || 0) + amount;
  const day = localDayKey(now);
  doc.days[day] = (doc.days[day] || 0) + amount;
  const entry = where?.part ? fileStatsEntry(doc, where.ids, where.title) : null;
  if (entry) {
    const part = entry.parts[where.part] || (entry.parts[where.part] = {});
    part.ms = (part.ms || 0) + amount;
    entry.at = Math.max(entry.at || 0, now);
  }
  doc.updatedAt = Math.max(doc.updatedAt || 0, now);
  return true;
}

// Records where the reader is in one reading part. Pure on `doc`.
export function setPartProgress(doc, ids, title, partKey, fields, now = Date.now()) {
  const entry = fileStatsEntry(doc, ids, title);
  if (!entry) return false;
  const part = entry.parts[partKey] || (entry.parts[partKey] = { ms: 0 });
  Object.assign(part, fields);
  part.at = now;
  part.furthestPct = Math.max(part.furthestPct || 0, Number(fields.pct) || 0);
  entry.at = now;
  doc.updatedAt = Math.max(doc.updatedAt || 0, now);
  return true;
}

// ── The device's copy ───────────────────────────────────────────────────────

function writeReadingStatsNow() {
  const current = readReadingStats();
  current.deviceId = deviceId();
  current.label = deviceLabel();
  pruneReadingStats(current);
  try {
    localStorage.setItem(READING_STATS_KEY, JSON.stringify(current));
  } catch { /* full or private mode: this session only */ }
}

function scheduleReadingStatsSave() {
  if (readingStatsSaveTimer) return;
  readingStatsSaveTimer = setTimeout(() => {
    readingStatsSaveTimer = 0;
    writeReadingStatsNow();
    announceReadingStats("saved");
  }, READING_STATS_SAVE_MS);
}

export function flushReadingStats() {
  if (!readingStatsSaveTimer) return;
  clearTimeout(readingStatsSaveTimer);
  readingStatsSaveTimer = 0;
  writeReadingStatsNow();
}

export function recordActiveTime(ms, where, now = Date.now()) {
  if (!addActiveTime(readReadingStats(), ms, where, now)) return;
  scheduleReadingStatsSave();
  announceReadingStats("time");
}

export function recordPartProgress(ids, title, partKey, fields, now = Date.now()) {
  if (!setPartProgress(readReadingStats(), ids, title, partKey, fields, now)) return;
  scheduleReadingStatsSave();
  announceReadingStats("progress");
}

// ── The other devices' records, as last pulled ──────────────────────────────

export function readOtherDeviceStats() {
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_STATS_DEVICES_KEY) || "null");
    return parsed && Array.isArray(parsed.rows) ? parsed : { rows: [], state: "", at: 0 };
  } catch {
    return { rows: [], state: "", at: 0 };
  }
}

export function writeOtherDeviceStats(rows, outcome) {
  try {
    localStorage.setItem(READING_STATS_DEVICES_KEY, JSON.stringify({ rows, state: outcome, at: Date.now() }));
  } catch { /* full or private mode: Home shows this device until the next pull */ }
  announceReadingStats("devices");
}

// Every record Home folds together: this device's, then the others'.
export function allReadingStatsRecords() {
  const own = readReadingStats();
  const records = [{ deviceId: deviceId(), label: deviceLabel(), own: true, stats: own }];
  for (const row of readOtherDeviceStats().rows) {
    if (!row || row.deviceId === deviceId()) continue;
    records.push({ deviceId: row.deviceId, label: row.label, own: false, stats: row.stats });
  }
  return records;
}

// Sign-out and account switch: these describe the previous account's library.
export function forgetAllReadingStats() {
  if (readingStatsSaveTimer) clearTimeout(readingStatsSaveTimer);
  readingStatsSaveTimer = 0;
  readingStatsDoc = null;
  try {
    localStorage.removeItem(READING_STATS_KEY);
    localStorage.removeItem(READING_STATS_DEVICES_KEY);
  } catch { /* nothing stored */ }
  forgetSpeedModel();
  announceReadingStats("forgotten");
}
