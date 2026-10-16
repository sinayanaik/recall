// Reading progress, time left, and the time log — measured on each device,
// carried between them, and added up the same way everywhere.
//
//   node tools/reading-stats-check.mjs
//
// The Kindle line at the foot of Notes and PDFs ("42% · Ch 3/12 · 8 min left in
// chapter · 1 h 10 min left") and Home's Keep reading / Your time sections rest
// on five modules in src/stats/. What is asserted here is what would be quietly
// wrong if it broke:
//
//   • THE ARITHMETIC. Words before an offset (checked against a naive count at
//     every position of a fixture), the chapter level, which chapter a
//     position is in, and how many are done.
//   • THE SPEED MODEL. Defaults until measured, a skim or a stall is not a
//     sample, a file's own rate takes over from the device's, and the estimate
//     follows the reader.
//   • THE TIME LOG. A tick never adds more than ten seconds, idle time is not
//     counted, minutes read before a file's first sync follow it to its cloud
//     id, and the store prunes itself.
//   • THE MERGE. Time from two devices is summed and never double counted, the
//     newest position wins, the furthest point is kept.
//   • THE SYNC. Each device writes only its own row, reads the others', and a
//     project without the table degrades to "this device only" without
//     throwing into a sync.
//
// Plain Node, like s3-config-sync-check.mjs: the modules are copied out with
// their ?v= stamps removed, localStorage is a map per "device", and the
// Supabase client is an in-memory table.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-stats-"));

function destamp(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) destamp(full);
    else if (entry.endsWith(".js")) {
      const text = readFileSync(full, "utf8");
      const clean = text.replaceAll("?v=__BUILD__", "");
      if (clean !== text) writeFileSync(full, clean);
    }
  }
}

const results = [];
let failures = 0;
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };

async function must(name, fn) {
  let detail;
  try {
    detail = await fn();
  } catch (error) {
    detail = `threw: ${error?.stack || error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  // ── A browser small enough for these modules, with swappable devices ───────
  const noElement = new Proxy({}, {
    get: (_, key) => (key === "querySelector" || key === "querySelectorAll" || key === "closest" ? () => null : undefined)
  });
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({}), addEventListener: () => {},
    documentElement: noElement, body: noElement, head: { appendChild: (node) => node }
  };
  const devices = new Map();
  let current = new Map();
  const onDevice = (name) => {
    if (!devices.has(name)) devices.set(name, new Map());
    current = devices.get(name);
  };
  onDevice("phone");
  globalThis.localStorage = {
    getItem: (key) => (current.has(key) ? current.get(key) : null),
    setItem: (key, value) => current.set(key, String(value)),
    removeItem: (key) => current.delete(key),
    key: (index) => [...current.keys()][index] ?? null,
    get length() { return current.size; }
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} };
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Mobile) Chrome/120.0" },
    configurable: true, writable: true
  });
  globalThis.fetch = async () => { throw new Error("no network in this check"); };

  const load = (rel) => import(path.join(stage, rel));
  const math = await load("src/stats/reading-math.js");
  const speed = await load("src/stats/reading-speed.js");
  const combine = await load("src/stats/combine.js");
  const store = await load("src/stats/reading-stats-store.js");
  const statsSync = await load("src/stats/stats-sync.js");
  const clientMod = await load("src/cloud/supabase-client.js");
  const device = await load("src/sync/device.js");

  // ── The arithmetic ────────────────────────────────────────────────────────

  await must("words before an offset match a naive count at every position", () => {
    // Long enough to cross several 1024-character checkpoints, with words
    // straddling them and runs of whitespace of every kind.
    let text = "";
    for (let i = 0; i < 900; i += 1) text += (i % 7 === 0 ? "  \n\t" : " ") + "w".repeat(1 + (i * 13) % 11) + (i % 5 === 0 ? "\n\n" : "");
    const index = math.buildWordIndex(text);
    const naive = (offset) => (text.slice(0, offset).match(/\S+/g) || []).length
      // A word the offset falls inside started before it, so it counts.
      - 0;
    const startsBefore = (offset) => {
      let count = 0;
      const re = /\S+/g;
      let m;
      while ((m = re.exec(text)) && m.index < offset) count += 1;
      return count;
    };
    if (index.total !== naive(text.length)) return `total ${index.total}, expected ${naive(text.length)}`;
    for (let offset = 0; offset <= text.length; offset += 1) {
      const got = math.wordsBeforeOffset(index, offset);
      const want = startsBefore(offset);
      if (got !== want) return `offset ${offset}: ${got}, expected ${want}`;
    }
    return true;
  });

  await must("an offset past the end, or before the start, is clamped", () => {
    const index = math.buildWordIndex("one two three");
    return math.wordsBeforeOffset(index, 999) === 3 && math.wordsBeforeOffset(index, -5) === 0
      || `${math.wordsBeforeOffset(index, 999)} / ${math.wordsBeforeOffset(index, -5)}`;
  });

  await must("a lone top-level title is skipped: chapters break at the next level", () => {
    const picked = math.pickChapterLevel([
      { start: 0, level: 0, title: "The Book" },
      { start: 2, level: 1, title: "One" },
      { start: 30, level: 1, title: "Two" },
      { start: 31, level: 2, title: "Two point one" },
      { start: 60, level: 1, title: "Three" }
    ]);
    return picked.map((c) => c.title).join(",") === "One,Two,Three" || picked.map((c) => c.title).join(",");
  });

  await must("several top-level entries are the chapters themselves", () => {
    const picked = math.pickChapterLevel([
      { start: 10, level: 1, title: "B" },
      { start: 0, level: 1, title: "A" },
      { start: 5, level: 2, title: "A.1" }
    ]);
    return picked.map((c) => c.title).join(",") === "A,B" || picked.map((c) => c.title).join(",");
  });

  await must("chapter position, chapters done and the rest of the chapter", () => {
    const chapters = [{ start: 0, title: "A" }, { start: 10, title: "B" }, { start: 25, title: "C" }];
    const mid = math.chapterProgress(chapters, 12, 12, 40);
    if (mid.chIndex !== 1 || mid.chTitle !== "B" || mid.chDone !== 1 || mid.chLeftUnits !== 13) return JSON.stringify(mid);
    // Reading back in chapter A after having reached C: A and B are still done.
    const back = math.chapterProgress(chapters, 3, 30, 40);
    if (back.chIndex !== 0 || back.chDone !== 2) return JSON.stringify(back);
    // At the end of the file, every chapter is done.
    const end = math.chapterProgress(chapters, 40, 40, 40);
    return (end.chDone === 3 && end.chLeftUnits === 0) || JSON.stringify(end);
  });

  await must("front matter before the first chapter is chapter -1, not chapter 1", () => {
    const front = math.chapterProgress([{ start: 4, title: "One" }, { start: 9, title: "Two" }], 1, 1, 20);
    return (front.chIndex === -1 && front.chDone === 0 && front.chLeftUnits === 3) || JSON.stringify(front);
  });

  await must("active time stops two minutes after the last input", () => {
    const IDLE = 120000;
    const all = math.activeSpan(0, 5000, 0, IDLE);
    const partial = math.activeSpan(118000, 123000, 0, IDLE);
    const none = math.activeSpan(200000, 205000, 0, IDLE);
    return (all === 5000 && partial === 2000 && none === 0) || `${all} / ${partial} / ${none}`;
  });

  await must("a fling is caught by its speed, however small each frame of it is", () => {
    // Reading a PDF: a fiftieth of a page over a frame, or a page over a minute.
    const reading = !math.isReadingJump("pdf", 0.02, 16) && !math.isReadingJump("pdf", 1, 60000);
    // A fling: half a page in a quarter second. A contents jump: five pages at once.
    const fling = math.isReadingJump("pdf", 0.5, 250);
    const jump = math.isReadingJump("pdf", 5, 60000);
    // Notes: 300 words a minute is reading; 400 words in half a second is not.
    const notesReading = !math.isReadingJump("notes", 5, 1000);
    const notesFling = math.isReadingJump("notes", 400, 500);
    return (reading && fling && jump && notesReading && notesFling) || `${reading} ${fling} ${jump} ${notesReading} ${notesFling}`;
  });

  await must("between exact readings, the note's place follows the scroll", () => {
    const calibration = { scrollTop: 1000, words: 500, wordsPerPx: 0.5 };
    const down = math.interpolateNotesWords(calibration, 1200, 4000, 0.3);
    const up = math.interpolateNotesWords(calibration, 900, 4000, 0.3);
    const average = math.interpolateNotesWords({ scrollTop: 0, words: 0, wordsPerPx: 0 }, 100, 4000, 0.3);
    const clamped = math.interpolateNotesWords(calibration, 999999, 4000, 0.3);
    return (down === 600 && up === 450 && near(average, 30) && clamped === 4000) || `${down} ${up} ${average} ${clamped}`;
  });

  await must("two exact readings set the local rate, unless they are too close or implausible", () => {
    const rate = math.calibrateWordsPerPx({ scrollTop: 0, words: 0 }, { scrollTop: 1000, words: 400 }, 0.3);
    const tooClose = math.calibrateWordsPerPx({ scrollTop: 0, words: 0 }, { scrollTop: 50, words: 20 }, 0.3);
    const wild = math.calibrateWordsPerPx({ scrollTop: 0, words: 0 }, { scrollTop: 1000, words: 5000 }, 0.3);
    const backwards = math.calibrateWordsPerPx({ scrollTop: 0, words: 100 }, { scrollTop: 1000, words: 50 }, 0.3);
    return (near(rate, 0.4) && tooClose === 0 && wild === 0 && backwards === 0) || `${rate} ${tooClose} ${wild} ${backwards}`;
  });

  // ── The speed model ───────────────────────────────────────────────────────

  await must("before anything is measured, the defaults: 2 min a page, 230 words a minute", () => {
    const model = speed.emptySpeedModel();
    const page = speed.speedFor(model, "pdf");
    const word = speed.speedFor(model, "notes");
    return (page === 120000 && near(word, 60000 / 230)) || `${page} / ${word}`;
  });

  await must("a skim and a stall are not reading", () => {
    const skim = speed.acceptableSpeedSample("pdf", 3, 6000); // 2 s a page
    const stall = speed.acceptableSpeedSample("pdf", 1, 20 * 60000); // 20 min a page
    const read = speed.acceptableSpeedSample("pdf", 1, 90000);
    const fastWords = speed.acceptableSpeedSample("notes", 1000, 30000); // 2000 wpm
    const words = speed.acceptableSpeedSample("notes", 300, 60000); // 300 wpm
    return (!skim && !stall && read && !fastWords && words) || `${skim} ${stall} ${read} ${fastWords} ${words}`;
  });

  await must("the device rate follows the reader, weighted by minutes read", () => {
    let model = speed.emptySpeedModel();
    // Ten minutes at one minute a page.
    for (let i = 0; i < 10; i += 1) model = speed.addSpeedSample(model, { kind: "pdf", units: 1, ms: 60000 });
    const learned = speed.speedFor(model, "pdf");
    if (!(learned < 70000 && learned >= 60000)) return `after ten minutes at 60 s a page: ${learned}`;
    // A rejected sample changes nothing.
    const same = speed.addSpeedSample(model, { kind: "pdf", units: 50, ms: 1000 });
    return same === model || "a rejected sample moved the model";
  });

  await must("a file's own rate takes over from the device's as the reader stays in it", () => {
    let model = speed.emptySpeedModel();
    for (let i = 0; i < 10; i += 1) model = speed.addSpeedSample(model, { kind: "pdf", units: 1, ms: 60000 });
    const device = speed.speedFor(model, "pdf", "file-x|doc:primary");
    // Twenty minutes in a dense file at five minutes a page.
    for (let i = 0; i < 20; i += 1) model = speed.addSpeedSample(model, { kind: "pdf", fileRateKey: "file-x|doc:primary", units: 0.2, ms: 60000 });
    const dense = speed.speedFor(model, "pdf", "file-x|doc:primary");
    const other = speed.speedFor(model, "pdf", "file-y|doc:primary");
    if (!(dense > 4 * 60000)) return `the dense file still reads at ${dense} ms a page`;
    // Another file uses the device rate, which the dense file has pulled up.
    return (other > device && other < dense) || `other file ${other}, device before ${device}, dense ${dense}`;
  });

  await must("the time left is the remaining amount at this device's rate", () => {
    const model = speed.emptySpeedModel();
    const left = speed.estimateRemainingMs(model, "notes", "", 2300);
    return near(left, 10 * 60000, 1) || `${left}`;
  });

  await must("the per-file rates are capped", () => {
    let model = speed.emptySpeedModel();
    for (let i = 0; i < speed.READING_SPEED_MAX_FILES + 25; i += 1) {
      model = speed.addSpeedSample(model, { kind: "notes", fileRateKey: `f${i}|notes`, units: 250, ms: 60000, at: i });
    }
    const keys = Object.keys(model.files);
    return (keys.length === speed.READING_SPEED_MAX_FILES && !model.files["f0|notes"] && Boolean(model.files[`f${speed.READING_SPEED_MAX_FILES + 24}|notes`]))
      || `${keys.length} kept`;
  });

  await must("the speed model is stored on this device and only this one", () => {
    onDevice("phone");
    speed.forgetSpeedModel();
    speed.recordSpeedSample({ kind: "notes", units: 250, ms: 60000 });
    const stored = JSON.parse(localStorage.getItem(speed.READING_SPEED_KEY) || "null");
    return Boolean(stored?.notes?.ms) || "nothing stored";
  });

  // ── The time log ──────────────────────────────────────────────────────────

  const DAY = new Date(2026, 9, 16, 12, 0, 0).getTime();

  await must("one tick never adds more than ten seconds", () => {
    const doc = store.emptyReadingStats();
    store.addActiveTime(doc, 6 * 60 * 60 * 1000, null, DAY);
    return doc.totalMs === store.READING_STATS_MAX_TICK_MS || `${doc.totalMs}`;
  });

  await must("time is filed under the day, the file and the part", () => {
    const doc = store.emptyReadingStats();
    const where = { ids: { deckId: "cloud-1", localDeckId: "ld1" }, title: "Biology", part: "notes" };
    store.addActiveTime(doc, 5000, where, DAY);
    store.addActiveTime(doc, 5000, where, DAY);
    store.addActiveTime(doc, 4000, null, DAY);
    const day = combine.localDayKey(DAY);
    const part = doc.files["cloud-1"]?.parts?.notes;
    return (doc.totalMs === 14000 && doc.days[day] === 14000 && part?.ms === 10000 && doc.files["cloud-1"].title === "Biology")
      || JSON.stringify(doc);
  });

  await must("minutes read before a file's first sync follow it to its cloud id", () => {
    const doc = store.emptyReadingStats();
    store.addActiveTime(doc, 8000, { ids: { deckId: null, localDeckId: "ld9" }, title: "Paper", part: "doc:primary" }, DAY);
    store.setPartProgress(doc, { deckId: null, localDeckId: "ld9" }, "Paper", "doc:primary", { pct: 0.3, pages: 10 }, DAY);
    // The first sync gives it a cloud id; the next tick carries both.
    store.addActiveTime(doc, 2000, { ids: { deckId: "cloud-9", localDeckId: "ld9" }, title: "Paper", part: "doc:primary" }, DAY + 1000);
    const moved = doc.files["cloud-9"]?.parts?.["doc:primary"];
    return (!doc.files["local:ld9"] && moved?.ms === 10000 && moved.pct === 0.3 && moved.furthestPct === 0.3) || JSON.stringify(doc.files);
  });

  await must("the furthest point is kept when the reader goes back", () => {
    const doc = store.emptyReadingStats();
    const ids = { deckId: "c", localDeckId: "l" };
    store.setPartProgress(doc, ids, "T", "notes", { pct: 0.8, words: 1000 }, DAY);
    store.setPartProgress(doc, ids, "T", "notes", { pct: 0.2, words: 1000 }, DAY + 1);
    const part = doc.files.c.parts.notes;
    return (part.pct === 0.2 && part.furthestPct === 0.8) || JSON.stringify(part);
  });

  await must("the store prunes old days and the least recent files", () => {
    const doc = store.emptyReadingStats();
    doc.days["2020-01-01"] = 1000;
    doc.days[combine.localDayKey(DAY)] = 1000;
    for (let i = 0; i < store.READING_STATS_MAX_FILES + 10; i += 1) doc.files[`f${i}`] = { at: i, parts: {} };
    store.pruneReadingStats(doc, DAY);
    return (!doc.days["2020-01-01"] && doc.days[combine.localDayKey(DAY)] && Object.keys(doc.files).length === store.READING_STATS_MAX_FILES && !doc.files.f0)
      || `${Object.keys(doc.days).length} days, ${Object.keys(doc.files).length} files`;
  });

  await must("recorded time is written through on flush and cleared on sign-out", () => {
    onDevice("phone");
    store.forgetAllReadingStats();
    store.recordActiveTime(5000, null);
    if (localStorage.getItem(store.READING_STATS_KEY)) return "written before the debounce or a flush";
    store.flushReadingStats();
    const written = JSON.parse(localStorage.getItem(store.READING_STATS_KEY) || "null");
    if (written?.totalMs !== 5000 || written.deviceId !== device.deviceId()) return JSON.stringify(written);
    localStorage.setItem(store.READING_STATS_DEVICES_KEY, "{\"rows\":[]}");
    store.forgetAllReadingStats();
    const left = [store.READING_STATS_KEY, store.READING_STATS_DEVICES_KEY, speed.READING_SPEED_KEY].filter((key) => localStorage.getItem(key) !== null);
    return left.length === 0 || `still stored: ${left.join(", ")}`;
  });

  // ── The merge ─────────────────────────────────────────────────────────────

  const phoneStats = {
    totalMs: 30 * 60000,
    days: { "2026-10-15": 10 * 60000, "2026-10-16": 20 * 60000 },
    files: {
      "cloud-1": {
        deckId: "cloud-1", localId: "phone-ld1", title: "Biology", at: 100,
        parts: { "doc:primary": { ms: 20 * 60000, pct: 0.4, furthestPct: 0.6, pages: 100, page: 41, chTotal: 10, chDone: 5, at: 100 } }
      }
    }
  };
  const deskStats = {
    totalMs: 45 * 60000,
    days: { "2026-10-16": 45 * 60000 },
    files: {
      "cloud-1": {
        deckId: "cloud-1", localId: "desk-ld7", title: "Biology", at: 200,
        parts: { "doc:primary": { ms: 40 * 60000, pct: 0.5, furthestPct: 0.5, pages: 100, page: 51, chTotal: 10, chDone: 4, at: 200 } }
      },
      "local:desk-ld8": { localId: "desk-ld8", title: "Draft", at: 150, parts: { notes: { ms: 5 * 60000, pct: 0.1, words: 900, at: 150 } } }
    }
  };
  const merged = combine.combineReadingStats([
    { deviceId: "dev-phone", label: "Chrome on Android phone", own: true, stats: phoneStats },
    { deviceId: "dev-desk", label: "Firefox on Linux", own: false, stats: deskStats }
  ], { now: DAY });

  await must("time from two devices is summed, per day and in all", () => {
    return (merged.totalMs === 75 * 60000 && merged.days["2026-10-16"] === 65 * 60000 && merged.todayMs === 65 * 60000 && merged.weekMs === 75 * 60000)
      || JSON.stringify({ total: merged.totalMs, days: merged.days, today: merged.todayMs, week: merged.weekMs });
  });

  await must("a file read on both devices: time summed, newest place, furthest point", () => {
    const part = merged.files["cloud-1"].parts["doc:primary"];
    return (part.ms === 60 * 60000 && part.pct === 0.5 && part.page === 51 && part.furthestPct === 0.6 && part.chDone === 5 && merged.files["cloud-1"].ms === 60 * 60000)
      || JSON.stringify(part);
  });

  await must("each device's total is listed, this device first", () => {
    const [first, second] = merged.devices;
    return (first.own && first.totalMs === 30 * 60000 && second.label === "Firefox on Linux" && second.totalMs === 45 * 60000)
      || JSON.stringify(merged.devices);
  });

  await must("a library entry finds its file by cloud id, or by this device's local id only", () => {
    const byCloud = combine.findCombinedFile(merged, { id: "anything", deckId: "cloud-1" });
    const byOwnLocal = combine.findCombinedFile(merged, { id: "phone-ld1", deckId: null });
    // Another device's local id names nothing here.
    const foreign = combine.findCombinedFile(merged, { id: "desk-ld8", deckId: null });
    return (byCloud === merged.files["cloud-1"] && byOwnLocal === merged.files["cloud-1"] && foreign === null) || "wrong match";
  });

  await must("chapters done are only compared between devices that counted the same chapters", () => {
    const a = { totalMs: 0, days: {}, files: { f: { parts: { notes: { pct: 0.5, chTotal: 12, chDone: 6, at: 1 } } } } };
    const b = { totalMs: 0, days: {}, files: { f: { parts: { notes: { pct: 0.3, chTotal: 8, chDone: 7, at: 2 } } } } };
    const part = combine.combineReadingStats([{ deviceId: "a", stats: a }, { deviceId: "b", stats: b }]).files.f.parts.notes;
    return (part.chTotal === 8 && part.chDone === 7) || JSON.stringify(part);
  });

  await must("a streak counts back from today, or from yesterday before today has a minute", () => {
    const days = { "2026-10-13": 120000, "2026-10-14": 120000, "2026-10-15": 120000 };
    const before = combine.readingStreak(days, DAY);
    days["2026-10-16"] = 90000;
    const after = combine.readingStreak(days, DAY);
    days["2026-10-14"] = 1000;
    const broken = combine.readingStreak(days, DAY);
    return (before === 3 && after === 4 && broken === 2) || `${before} / ${after} / ${broken}`;
  });

  await must("durations read the way a person says them", () => {
    const got = [0, 59000, 12 * 60000, 60 * 60000, 65 * 60000, 125 * 60000].map((ms) => combine.formatDuration(ms, { short: true }));
    const want = ["<1 min", "1 min", "12 min", "1 h", "1 h 05 min", "2 h 05 min"];
    return got.join("|") === want.join("|") || got.join("|");
  });

  await must("reading parts are Notes and PDFs only, newest first", () => {
    const parts = combine.readingPartsOf({ parts: { cards: { ms: 5 }, notes: { pct: 0.1, at: 1 }, "doc:p2": { pct: 0.4, at: 5 }, handwriting: { ms: 9 } } });
    return parts.map((p) => p.key).join(",") === "doc:p2,notes" || parts.map((p) => p.key).join(",");
  });

  // ── The sync ──────────────────────────────────────────────────────────────

  const USER = "11111111-1111-1111-1111-111111111111";
  const table = new Map();
  const calls = [];
  let tableMissing = false;
  const client = {
    from(name) {
      const query = { op: "select", filters: {}, payload: null };
      const run = () => {
        calls.push(`${query.op} ${name}`);
        if (name !== statsSync.READING_STATS_TABLE) return { data: [], error: null };
        if (tableMissing) return { data: null, error: { code: "42P01", message: `relation "${name}" does not exist` } };
        if (query.op === "upsert") {
          table.set(`${query.payload.user_id}|${query.payload.device_id}`, JSON.parse(JSON.stringify(query.payload)));
          return { data: null, error: null };
        }
        const rows = [...table.values()].filter((row) => row.user_id === query.filters.user_id);
        return { data: rows.map((row) => ({ ...row })), error: null };
      };
      const builder = {
        select() { return builder; },
        eq(column, value) { query.filters[column] = value; return builder; },
        upsert(payload) { query.op = "upsert"; query.payload = payload; return builder; },
        abortSignal() { return builder; },
        then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject); }
      };
      return builder;
    },
    auth: {
      getSession: async () => ({ data: { session: { user: { id: USER }, access_token: "t", expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null })
    }
  };
  clientMod.setSupabaseClient(client);

  // Each "device" has its own module state too: the store caches its record
  // in memory, so switching devices means forgetting that cache.
  // The device id is cached in memory for a browser that cannot store one, so
  // each device here is given its own up front, as a real one would have.
  const switchTo = (name) => {
    store.flushReadingStats();
    onDevice(name);
    if (!current.has(device.DEVICE_ID_KEY)) current.set(device.DEVICE_ID_KEY, `dev-${name}`);
    // Drop the in-memory copy without touching what this device has stored.
    const saved = new Map(current);
    store.forgetAllReadingStats();
    for (const [key, value] of saved) current.set(key, value);
  };

  await must("each device writes only its own row and reads the others'", async () => {
    switchTo("phone");
    store.recordActiveTime(9000, { ids: { deckId: "cloud-1", localDeckId: "p1" }, title: "Biology", part: "notes" });
    store.recordPartProgress({ deckId: "cloud-1", localDeckId: "p1" }, "Biology", "notes", { pct: 0.25, words: 4000 });
    const phoneId = device.deviceId();
    const first = await statsSync.syncReadingStatsWithCloud(USER);
    if (first.state !== "synced") return `phone: ${first.state} ${first.detail || ""}`;

    switchTo("desk");
    const deskId = device.deviceId();
    if (deskId === phoneId) return "both devices have one id";
    store.recordActiveTime(7000, { ids: { deckId: "cloud-1", localDeckId: "d4" }, title: "Biology", part: "notes" });
    store.recordPartProgress({ deckId: "cloud-1", localDeckId: "d4" }, "Biology", "notes", { pct: 0.5, words: 4000 });
    const second = await statsSync.syncReadingStatsWithCloud(USER);
    if (second.state !== "synced") return `desk: ${second.state}`;
    if (table.size !== 2) return `${table.size} rows`;
    if (table.get(`${USER}|${phoneId}`).stats.totalMs !== 9000) return "the desk changed the phone's row";

    const combined = combine.combineReadingStats(store.allReadingStatsRecords());
    const notes = combined.files["cloud-1"]?.parts?.notes;
    return (combined.totalMs === 16000 && notes?.ms === 16000 && notes.pct === 0.5 && combined.devices.length === 2)
      || JSON.stringify({ total: combined.totalMs, notes, devices: combined.devices.length });
  });

  await must("a device with nothing new reads without writing", async () => {
    switchTo("desk");
    await statsSync.syncReadingStatsWithCloud(USER);
    calls.length = 0;
    await statsSync.syncReadingStatsWithCloud(USER);
    return (calls.length === 1 && calls[0] === `select ${statsSync.READING_STATS_TABLE}`) || calls.join(", ");
  });

  await must("the pushed row carries no push bookkeeping, and a pushed device is clean", async () => {
    switchTo("phone");
    const row = [...table.values()].find((r) => r.device_id === device.deviceId());
    return (row && !("pushedAt" in row.stats) && row.stats.deviceId === device.deviceId() && !store.readingStatsDirty())
      || JSON.stringify(row?.stats);
  });

  await must("a project without the table says so, keeps the last copy, and does not throw", async () => {
    switchTo("phone");
    const before = store.readOtherDeviceStats().rows.length;
    store.recordActiveTime(3000, null);
    tableMissing = true;
    try {
      const outcome = await statsSync.syncReadingStatsWithCloud(USER);
      const cached = store.readOtherDeviceStats();
      return (outcome.state === "unavailable" && cached.state === "unavailable" && cached.rows.length === before && store.readingStatsDirty())
        || JSON.stringify({ outcome, state: cached.state, rows: cached.rows.length });
    } finally {
      tableMissing = false;
    }
  });

  await must("signed out or offline, nothing is sent", async () => {
    calls.length = 0;
    const signedOut = await statsSync.syncReadingStatsWithCloud(null);
    navigator.onLine = false;
    const offline = await statsSync.syncReadingStatsWithCloud(USER);
    navigator.onLine = true;
    return (signedOut.state === "signed-out" && offline.state === "offline" && calls.length === 0) || `${signedOut.state} ${offline.state} ${calls.join(",")}`;
  });

  await must("a client that throws is survived, not propagated into the sync", async () => {
    clientMod.setSupabaseClient({ from: () => { throw new Error("this stub refuses every query"); }, auth: client.auth });
    try {
      const outcome = await statsSync.syncReadingStatsWithCloud(USER);
      return outcome.state === "failed" || outcome.state;
    } finally {
      clientMod.setSupabaseClient(client);
    }
  });

  console.warn = realWarn;
  console.log("── reading stats ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  const noted = warnings.length ? ` · ${warnings.length} expected warning(s)` : "";
  console.log(`\nCHECK: ${results.length} checks · ${failures} failed${noted}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
