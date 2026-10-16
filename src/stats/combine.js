// Several devices' reading stats, folded into the one picture Home shows.
//
// Every device writes ONLY its own record (src/stats/stats-sync.js), so there is
// never anything to reconcile on the way in: the merge happens here, on read,
// and the same answer comes out whichever device does it.
//
//   time         summed — each device counted only the minutes it saw
//   position     the newest, wherever it was read (the place to pick up from)
//   furthest     the furthest anywhere (what "chapters done" is measured on)
//
// Pure and DOM-free, so tools/reading-stats-check.mjs runs it under Node.

const POSITION_FIELDS = ["pct", "page", "pages", "words", "name", "chTitle", "chTotal", "chIndex", "chPct"];

export function localDayKey(at = Date.now()) {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// The calendar days ending today, oldest first: ["2026-10-03", …, today].
export function recentDayKeys(count, now = Date.now()) {
  const keys = [];
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = new Date(date);
    day.setDate(date.getDate() - i);
    keys.push(localDayKey(day.getTime()));
  }
  return keys;
}

function mergePart(into, part, fromDevice) {
  if (!into) {
    return { ...part, ms: part.ms || 0, furthestPct: part.furthestPct ?? part.pct ?? 0, devices: [fromDevice] };
  }
  const merged = { ...into };
  merged.ms = (into.ms || 0) + (part.ms || 0);
  merged.devices = [...into.devices, fromDevice];
  const newer = (part.at || 0) > (into.at || 0);
  if (newer) {
    for (const field of POSITION_FIELDS) {
      if (part[field] !== undefined) merged[field] = part[field];
    }
    merged.at = part.at;
  }
  merged.furthestPct = Math.max(into.furthestPct || 0, part.furthestPct ?? part.pct ?? 0);
  // Chapters done is a count against a chapter list; two devices can only be
  // compared when they counted the same list.
  const total = merged.chTotal;
  const doneHere = part.chTotal === total ? (part.chDone || 0) : 0;
  const doneThere = into.chTotal === total ? (into.chDone || 0) : 0;
  merged.chDone = Math.max(doneHere, doneThere);
  return merged;
}

// `records` is [{ deviceId, label, own, stats }] — this device's own record and
// every other device's last-pulled copy.
export function combineReadingStats(records, { now = Date.now() } = {}) {
  const days = {};
  const files = {};
  const devices = [];
  let totalMs = 0;

  for (const record of records || []) {
    const stats = record?.stats;
    if (!stats || typeof stats !== "object") continue;
    const recordDevice = record.deviceId || stats.deviceId || "";
    const deviceTotal = Number(stats.totalMs) || 0;
    totalMs += deviceTotal;
    devices.push({ deviceId: recordDevice, label: record.label || stats.label || "", own: Boolean(record.own), totalMs: deviceTotal, updatedAt: stats.updatedAt || 0 });
    for (const [day, ms] of Object.entries(stats.days || {})) {
      days[day] = (days[day] || 0) + (Number(ms) || 0);
    }
    for (const [fileKey, file] of Object.entries(stats.files || {})) {
      if (!file || typeof file !== "object") continue;
      const target = files[fileKey] || (files[fileKey] = { fileKey, deckId: null, localIds: [], title: "", at: 0, ms: 0, parts: {} });
      if (file.deckId) target.deckId = file.deckId;
      // A local id means something only on the device that minted it.
      if (record.own && file.localId) target.localIds.push(file.localId);
      if ((file.at || 0) >= target.at) {
        target.at = file.at || 0;
        if (file.title) target.title = file.title;
      }
      for (const [partKey, part] of Object.entries(file.parts || {})) {
        if (!part || typeof part !== "object") continue;
        target.parts[partKey] = mergePart(target.parts[partKey], part, recordDevice);
        target.ms += Number(part.ms) || 0;
      }
    }
  }

  devices.sort((a, b) => (b.own - a.own) || (b.totalMs - a.totalMs));
  // This device's local ids, for library entries that have no cloud id yet.
  const byLocalId = {};
  for (const file of Object.values(files)) {
    for (const localId of file.localIds) byLocalId[localId] = file;
  }
  const today = localDayKey(now);
  const week = recentDayKeys(7, now);
  return {
    totalMs,
    todayMs: days[today] || 0,
    weekMs: week.reduce((sum, day) => sum + (days[day] || 0), 0),
    streak: readingStreak(days, now),
    days,
    files,
    byLocalId,
    devices
  };
}

// Consecutive days with at least a minute in the app, ending today — or ending
// yesterday, so a streak is not shown as broken at breakfast.
export function readingStreak(days, now = Date.now()) {
  const keys = recentDayKeys(400, now).reverse();
  const minute = 60 * 1000;
  let start = 0;
  if ((days[keys[0]] || 0) < minute) start = 1;
  let streak = 0;
  for (let i = start; i < keys.length; i += 1) {
    if ((days[keys[i]] || 0) < minute) break;
    streak += 1;
  }
  return streak;
}

// The reading parts of a combined file — Notes and each PDF — newest first.
export function readingPartsOf(file) {
  return Object.entries(file?.parts || {})
    .filter(([key, part]) => (key === "notes" || key.startsWith("doc:")) && Number.isFinite(part.pct))
    .map(([key, part]) => ({ key, ...part }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

// Which combined file a library entry is: by its cloud id first (the one every
// device shares), then by this device's local id.
export function findCombinedFile(combined, entry) {
  if (!combined || !entry) return null;
  if (entry.deckId && combined.files[entry.deckId]) return combined.files[entry.deckId];
  // Only this device's own local ids: another device's means nothing here.
  return (entry.id && combined.byLocalId?.[entry.id]) || null;
}

// "1 h 05 min", "12 min", "under a minute".
export function formatDuration(ms, { short = false } = {}) {
  const minutes = Math.round((Number(ms) || 0) / 60000);
  if (minutes < 1) return short ? "<1 min" : "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 100 || rest === 0) return `${hours} h`;
  return `${hours} h ${String(rest).padStart(2, "0")} min`;
}
