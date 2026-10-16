// Home's reading picture: how far through each file's Notes and PDFs the
// reader is, how long the rest will take, and how much time they have spent in
// the app — today, this week, in all, and on which device.
//
// Everything is read from what is already on the device: this device's stats
// and the other devices' last-pulled copies (src/stats/reading-stats-store.js),
// folded by src/stats/combine.js. The time left is always divided by THIS
// device's reading speed (src/stats/reading-speed.js). Nothing here waits on
// the network, so it paints in the same frame as the rest of Home.

import { hasActiveDeck } from "../cards/card-status.js?v=__BUILD__";
import { state } from "../core/state.js?v=__BUILD__";
import { activePdfId, deckPdfById } from "../documents/pdf-multi.js?v=__BUILD__";
import { loadDeckEntry } from "../library/my-decks-actions.js?v=__BUILD__";
import { scheduleDeckAutosave } from "../storage/deck-store.js?v=__BUILD__";
import {
  combineReadingStats, findCombinedFile, formatDuration, readingPartsOf, recentDayKeys
} from "../stats/combine.js?v=__BUILD__";
import { allReadingStatsRecords, onReadingStatsChanged, readOtherDeviceStats } from "../stats/reading-stats-store.js?v=__BUILD__";
import { estimateRemainingMs, readSpeedModel } from "../stats/reading-speed.js?v=__BUILD__";
import { hideHome, scheduleHomeRender, showHome } from "./home-state.js?v=__BUILD__";
import { setViewMode } from "./view-mode.js?v=__BUILD__";

const HOME_READING_LIMIT = 6;
const HOME_TOP_FILES_LIMIT = 5;
const HOME_CHART_DAYS = 14;

// A part counts as being read between these: opened, and not yet finished.
const READING_FROM = 0.01;
const READING_UNTIL = 0.995;

export function combinedReadingStats() {
  return combineReadingStats(allReadingStatsRecords());
}

// Time left in one combined part, on this device's speed.
export function partTimeLeft(file, part) {
  const kind = part.key === "notes" ? "notes" : "pdf";
  const total = kind === "pdf" ? Number(part.pages) || 0 : Number(part.words) || 0;
  if (!total) return 0;
  const remaining = Math.max(0, (1 - (Number(part.pct) || 0)) * total);
  return estimateRemainingMs(readSpeedModel(), kind, `${file.fileKey}|${part.key}`, remaining);
}

function partName(part) {
  if (part.key === "notes") return "Notes";
  return part.name ? `PDF · ${part.name}` : "PDF";
}

// "42% · 3 of 12 chapters · 1 h 10 min left"
export function describeReadingPart(file, part) {
  const pct = Number(part.pct) || 0;
  const bits = [`${Math.floor(pct * 100)}%`];
  if (part.chTotal > 1) bits.push(`${part.chDone || 0} of ${part.chTotal} chapters`);
  if (pct >= READING_UNTIL) bits.push("finished");
  else {
    const left = partTimeLeft(file, part);
    if (left > 0) bits.push(`${formatDuration(left, { short: true })} left`);
  }
  return bits.join(" · ");
}

// The part of a library entry's file read most recently, or null.
export function latestReadingPart(combined, deck) {
  const file = findCombinedFile(combined, deck);
  const part = file ? readingPartsOf(file)[0] : null;
  return part ? { file, part } : null;
}

function progressBar(pct, className = "home-progress") {
  const bar = document.createElement("span");
  bar.className = className;
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", String(Math.floor(pct * 100)));
  const fill = document.createElement("span");
  fill.className = "home-progress-fill";
  fill.style.width = `${Math.min(100, Math.max(0, pct * 100)).toFixed(1)}%`;
  bar.append(fill);
  return bar;
}

export function homeTileProgress(combined, deck) {
  const latest = latestReadingPart(combined, deck);
  if (!latest) return null;
  const wrap = document.createElement("span");
  wrap.className = "home-deck-progress";
  const label = document.createElement("span");
  label.className = "home-deck-progress-label";
  label.textContent = `${Math.floor((Number(latest.part.pct) || 0) * 100)}% of ${latest.part.key === "notes" ? "Notes" : "PDF"}`;
  wrap.append(progressBar(Number(latest.part.pct) || 0), label);
  return wrap;
}

// Opens a file on the part the row is about — its Notes, or that one PDF.
async function openFileAtPart(deck, partKey) {
  hideHome();
  if (!(hasActiveDeck() && state.localDeckId === deck.id)) await loadDeckEntry(deck, "local");
  if (!hasActiveDeck()) {
    showHome();
    return;
  }
  if (partKey === "notes") {
    setViewMode("notes");
    return;
  }
  const pdfId = partKey.slice("doc:".length);
  // Written to the file before the tab opens, which is what switchToPdf does:
  // the open reads which PDF from here, so there is only one open.
  if (pdfId && deckPdfById(state.meta, pdfId) && activePdfId(state.meta) !== pdfId) {
    state.meta = { ...state.meta, pdfActiveId: pdfId };
    scheduleDeckAutosave();
  }
  setViewMode("document");
}

function buildReadingRow(deck, file, part) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "home-reading-row";
  row.setAttribute("aria-label", `Keep reading ${deck.title || "Untitled file"}, ${partName(part)}`);
  const title = document.createElement("span");
  title.className = "home-reading-title";
  title.textContent = deck.title || file.title || "Untitled file";
  const where = document.createElement("span");
  where.className = "home-reading-part";
  where.textContent = part.chTitle ? `${partName(part)} · ${part.chTitle}` : partName(part);
  const facts = document.createElement("span");
  facts.className = "home-reading-facts";
  facts.textContent = describeReadingPart(file, part);
  row.append(title, where, progressBar(Number(part.pct) || 0), facts);
  row.addEventListener("click", () => openFileAtPart(deck, part.key));
  return row;
}

function renderKeepReading(combined, decks) {
  const section = document.getElementById("homeReadingSection");
  const list = document.getElementById("homeReading");
  if (!section || !list) return;
  const rows = [];
  for (const deck of decks) {
    const file = findCombinedFile(combined, deck);
    if (!file) continue;
    const part = readingPartsOf(file).find((candidate) => candidate.pct >= READING_FROM && candidate.pct < READING_UNTIL);
    if (part) rows.push({ deck, file, part });
  }
  rows.sort((a, b) => (b.part.at || 0) - (a.part.at || 0));
  const shown = rows.slice(0, HOME_READING_LIMIT);
  list.replaceChildren(...shown.map(({ deck, file, part }) => buildReadingRow(deck, file, part)));
  section.hidden = shown.length === 0;
}

function dayLabel(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "narrow" });
}

function renderTimeTotals(combined) {
  const totals = document.getElementById("homeTimeTotals");
  if (!totals) return;
  const tile = (label, ms) => {
    const box = document.createElement("div");
    box.className = "home-time-total";
    const value = document.createElement("span");
    value.className = "home-time-value";
    value.textContent = formatDuration(ms, { short: true });
    const name = document.createElement("span");
    name.className = "home-time-name";
    name.textContent = label;
    box.append(value, name);
    return box;
  };
  const streak = document.createElement("div");
  streak.className = "home-time-total";
  const streakValue = document.createElement("span");
  streakValue.className = "home-time-value";
  streakValue.textContent = String(combined.streak);
  const streakName = document.createElement("span");
  streakName.className = "home-time-name";
  streakName.textContent = combined.streak === 1 ? "day in a row" : "days in a row";
  streak.append(streakValue, streakName);
  totals.replaceChildren(tile("Today", combined.todayMs), tile("Last 7 days", combined.weekMs), tile("All time", combined.totalMs), streak);
}

function renderTimeChart(combined) {
  const chart = document.getElementById("homeTimeChart");
  if (!chart) return;
  const keys = recentDayKeys(HOME_CHART_DAYS);
  const values = keys.map((key) => combined.days[key] || 0);
  const max = Math.max(...values, 15 * 60 * 1000);
  const today = keys[keys.length - 1];
  chart.replaceChildren(...keys.map((key, index) => {
    const column = document.createElement("div");
    column.className = "home-chart-day";
    if (key === today) column.classList.add("is-today");
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    column.title = `${date}: ${formatDuration(values[index])}`;
    const bar = document.createElement("span");
    bar.className = "home-chart-bar";
    bar.style.height = `${values[index] ? Math.max(4, (values[index] / max) * 100) : 0}%`;
    const label = document.createElement("span");
    label.className = "home-chart-label";
    label.textContent = dayLabel(key);
    column.append(bar, label);
    return column;
  }));
  chart.setAttribute("aria-label", `Time in the app over the last ${HOME_CHART_DAYS} days`);
}

function renderTopFiles(combined, decks) {
  const list = document.getElementById("homeTimeFiles");
  if (!list) return;
  const titleFor = new Map();
  const deckFor = new Map();
  for (const deck of decks) {
    const file = findCombinedFile(combined, deck);
    if (file) {
      titleFor.set(file.fileKey, deck.title);
      deckFor.set(file.fileKey, deck);
    }
  }
  // Only files still in this library: a deleted file's minutes still count in
  // the totals, but it is not a thing to list.
  const top = Object.values(combined.files)
    .filter((file) => file.ms >= 60 * 1000 && deckFor.has(file.fileKey))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, HOME_TOP_FILES_LIMIT);
  const most = top[0]?.ms || 1;
  list.replaceChildren(...top.map((file) => {
    const item = document.createElement("li");
    item.className = "home-time-file";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "home-time-file-btn";
    const name = document.createElement("span");
    name.className = "home-time-file-name";
    name.textContent = titleFor.get(file.fileKey) || file.title || "Untitled file";
    const time = document.createElement("span");
    time.className = "home-time-file-time";
    time.textContent = formatDuration(file.ms, { short: true });
    button.append(name, time, progressBar(file.ms / most, "home-progress home-progress-quiet"));
    const deck = deckFor.get(file.fileKey);
    button.addEventListener("click", async () => {
      hideHome();
      await loadDeckEntry(deck, "local");
      if (!hasActiveDeck()) showHome();
    });
    item.append(button);
    return item;
  }));
  list.hidden = top.length === 0;
}

function renderDevices(combined) {
  const line = document.getElementById("homeTimeDevices");
  if (!line) return;
  const others = readOtherDeviceStats();
  if (others.state === "unavailable") {
    line.textContent = "This device only — re-run supabase_setup.sql in your project to bring in your other devices.";
    return;
  }
  const devices = combined.devices.filter((device) => device.totalMs >= 60 * 1000 || device.own);
  if (devices.length <= 1) {
    line.textContent = "Measured on this device. Your other devices add theirs when they sync.";
    return;
  }
  line.textContent = devices
    .map((device) => `${device.own ? "This device" : device.label || "Another device"} ${formatDuration(device.totalMs, { short: true })}`)
    .join(" · ");
}

// The hero's second line: "Today 42 min · Last 7 days 5 h 10 min · 6 days in a row".
export function homeTimeLine(combined) {
  if (!combined.totalMs) return "";
  const bits = [`Today ${formatDuration(combined.todayMs, { short: true })}`, `Last 7 days ${formatDuration(combined.weekMs, { short: true })}`];
  if (combined.streak > 1) bits.push(`${combined.streak} days in a row`);
  return bits.join(" · ");
}

export function renderHomeStats(combined, decks) {
  renderKeepReading(combined, decks);
  const section = document.getElementById("homeTimeSection");
  if (section) section.hidden = combined.totalMs < 60 * 1000;
  if (section?.hidden) return;
  renderTimeTotals(combined);
  renderTimeChart(combined);
  renderTopFiles(combined, decks);
  renderDevices(combined);
}

// Home repaints when the numbers move — but the time log moves every few
// seconds while the app is in use, and a clock on Home ticking by the second is
// noise. Progress and pulled devices repaint at once; time, at most twice a
// minute.
const HOME_TIME_REPAINT_MS = 30 * 1000;
let lastTimeRepaint = 0;

export function initHomeStats() {
  onReadingStatsChanged((kind) => {
    if (kind === "time") {
      const now = Date.now();
      if (now - lastTimeRepaint < HOME_TIME_REPAINT_MS) return;
      lastTimeRepaint = now;
    }
    scheduleHomeRender();
  });
}
