// When this library was last backed up, and whether it is time to say so.
//
// Nothing recorded it. A backup happened when someone remembered to click, and
// the app had no idea whether that was yesterday or never — so it could not tell
// you, and it could not ask. "Do I have a copy of this?" is the question the
// answer to which decides whether a lost phone is an afternoon or a year, and
// the only place it could be answered was the user's own Downloads folder.
//
// Deliberately small. This is a record and a reminder, not a scheduler: there is
// no ticker, no background work, and nothing that produces a file you did not
// ask for. A backup is a thing you decide to do; the app's job is to make sure
// you know when you last did.

const LAST_BACKUP_KEY = "recall:lastBackup";

// How long before a library that has changed is worth mentioning. Long enough
// that someone who backs up monthly is never nagged, short enough to be the
// difference between losing a week and losing a term.
export const BACKUP_NUDGE_DAYS = 14;

export const BACKUP_NUDGE_MS = BACKUP_NUDGE_DAYS * 24 * 60 * 60 * 1000;

export function readLastBackup() {
  try {
    const raw = localStorage.getItem(LAST_BACKUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.at ? parsed : null;
  } catch {
    return null;
  }
}

// Recorded on a finished backup only. `kind: "safety"` is the archive a restore
// writes before it changes anything, and it is stored so the file can be found
// again — but it does not move the nudge: a restore is not a decision to back
// up, and telling someone they are covered because they restored something is
// exactly the wrong moment to be wrong.
export function recordBackup({ decks = 0, cards = 0, documents = 0, bytes = 0, name = "", kind = "manual" } = {}) {
  const record = { at: new Date().toISOString(), decks, cards, documents, bytes, name, kind };
  try {
    if (kind === "safety") {
      const previous = readLastBackup();
      localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify({ ...record, at: previous?.at || record.at, safetyAt: record.at, kind: previous?.kind || "safety" }));
    } else {
      localStorage.setItem(LAST_BACKUP_KEY, JSON.stringify(record));
    }
  } catch (error) {
    // Quota, most likely. Losing the record costs the reminder, never the
    // archive that was just written.
    console.warn("Could not record the backup", error);
  }
  return record;
}

export function backupAgeMs(record = readLastBackup(), now = Date.now()) {
  if (!record?.at) return Infinity;
  const at = Date.parse(record.at);
  return Number.isFinite(at) ? Math.max(0, now - at) : Infinity;
}

// "3 days ago" / "never". Deliberately coarse: the point is whether it was
// recently, and a timestamp to the minute invites reading precision into a
// number that only matters in weeks.
export function formatBackupAge(record = readLastBackup(), now = Date.now()) {
  if (!record?.at) return "never";
  const days = Math.floor(backupAgeMs(record, now) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

// Is it worth saying something? Two conditions, and BOTH have to hold, because
// either alone produces a reminder nobody should see: a library that has not
// changed does not need a new copy however old the last one is, and a library
// that changed this morning does not need one if it was backed up this morning
// too.
//
// `changedAt` is the newest updatedAt in the local deck index — the caller has
// it in hand from the list it is already rendering, so this costs no read.
export function backupNudgeDue({ record = readLastBackup(), changedAt = 0, deckCount = 0, now = Date.now() } = {}) {
  if (!deckCount) return false;
  if (!record?.at) return true;
  if (backupAgeMs(record, now) < BACKUP_NUDGE_MS) return false;
  const backedUpAt = Date.parse(record.at) || 0;
  return Number(changedAt) > backedUpAt;
}

// One line for the ⋯ menu and the Storage panel. Same sentence in both places on
// purpose — it is the same fact, and two phrasings of it would read as two.
export function describeLastBackup(record = readLastBackup()) {
  if (!record?.at) return "Never backed up";
  const bits = [`Last backup: ${formatBackupAge(record)}`];
  if (record.decks) bits.push(`${record.decks} deck${record.decks === 1 ? "" : "s"}`);
  if (record.documents) bits.push(`${record.documents} paper${record.documents === 1 ? "" : "s"}`);
  return bits.join(" · ");
}
