// The Quick Notes deck's user-defined subject categories.
//
// They live in the deck's meta bag rather than a table, so they sync with the
// deck itself. Edits are expressed as OPERATIONS (upsert/delete) rather than a
// whole-list write, so two devices renaming different categories merge instead
// of one silently winning.

import { LAST_USER_STORAGE_KEY } from "../boot.js?v=__BUILD__";
import { isMissingColumnError } from "../cloud/deck-list.js?v=__BUILD__";
import { isSignedIn, supabaseClient } from "../cloud/supabase-client.js?v=__BUILD__";
import { defaultDeckCategory } from "../core/constants.js?v=__BUILD__";
import { readLocalDeckIndex, writeLocalDeckIndex } from "../library/local-library.js?v=__BUILD__";
import { state } from "../main.js?v=__BUILD__";
import { serialiseQuickNoteMetaWrite } from "./anchors.js?v=__BUILD__";
import { ensureQuickNotesDeck } from "./board.js?v=__BUILD__";
import { QUICK_NOTES_DECK_TITLE, QUICK_NOTE_CATEGORIES_CACHE_KEY, QUICK_NOTE_DEFAULT_COLOR } from "./palette.js?v=__BUILD__";
import { readDeckSnapshot, withDeckLock, writeDeckSnapshot } from "../storage/deck-store.js?v=__BUILD__";

// Current signed-in user's id, read synchronously from the marker written by
// ensureLocalLibraryOwner — lets render code detect the quick_notes deck and
// build its id without an async auth round-trip.
export function cachedUserId() {
  try { return localStorage.getItem(LAST_USER_STORAGE_KEY) || null; } catch { return null; }
}

// Deterministic id of the current user's quick_notes deck (or null if unknown).
export function getQuickNotesDeckId() {
  const uid = cachedUserId();
  return uid ? `quick-notes-${uid}` : null;
}

// True when a deck (by id and/or title) is the special quick_notes deck.
export function isQuickNotesDeck(deckId = state.deckId, title = state.deckTitle) {
  if (deckId && String(deckId).startsWith("quick-notes-")) return true;
  const qid = getQuickNotesDeckId();
  if (qid && String(deckId) === qid) return true;
  return String(title || "").trim().toLowerCase() === QUICK_NOTES_DECK_TITLE;
}

export function normalizeCategoryColor(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : QUICK_NOTE_DEFAULT_COLOR;
}

export function generateCategoryId() {
  return `qc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Coerce any stored list into clean [{ id, name, color }] entries (deduped).
export function normalizeQuickNoteCategories(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim();
    const name = String(raw.name || "").trim();
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, color: normalizeCategoryColor(raw.color) });
  }
  return out;
}

// Pull the managed category set out of a deck row's meta JSON (defensive: meta
// may be a parsed object, a JSON string, or missing on pre-migration rows).
export function quickNoteCategoriesFromMeta(meta) {
  let bag = meta;
  if (typeof bag === "string") {
    try { bag = JSON.parse(bag); } catch { bag = null; }
  }
  const list = bag && typeof bag === "object" ? bag.quickNoteCategories : null;
  return normalizeQuickNoteCategories(list);
}

export function readCachedQuickNoteCategories() {
  try {
    return normalizeQuickNoteCategories(JSON.parse(localStorage.getItem(QUICK_NOTE_CATEGORIES_CACHE_KEY) || "[]"));
  } catch { return []; }
}

export function writeCachedQuickNoteCategories(list) {
  try { localStorage.setItem(QUICK_NOTE_CATEGORIES_CACHE_KEY, JSON.stringify(list)); } catch (_) {}
}

// Read a local deck snapshot by its cloud deckId (not the local ld_ id).
export async function readLocalSnapshotByDeckId(deckId) {
  if (!deckId) return null;
  const entry = readLocalDeckIndex().find((e) => e.deckId === deckId);
  if (!entry) return null;
  const snapshot = await readDeckSnapshot(entry.id);
  return snapshot ? { localId: entry.id, snapshot } : null;
}

// The local quick_notes snapshot, creating an empty one if this device has none
// yet. Every quick-note write is local-first now, so there has to be somewhere
// on this device for it to land — a device that has opened the board (which
// reads the cloud directly) but never run a reconcile would otherwise have no
// snapshot at all, and the write would vanish.
//
// The local id is derived from the cloud id for the same reason
// pullCloudDeckToLibrary derives its own: "find existing, else create" isn't
// atomic across tabs, and a deterministic id makes concurrent creators converge
// instead of leaving an orphan snapshot behind.
// The local id the quick_notes deck resolves to — the index entry if one
// exists, else the same deterministic fallback ensureLocalQuickNotesSnapshot
// and pullCloudDeckToLibrary both use, so all three agree on the lock key even
// before the snapshot exists.
export function quickNotesLocalId(deckId) {
  return readLocalDeckIndex().find((e) => e.deckId === deckId)?.id || `ld_cloud_${deckId}`;
}

// NOT locked on purpose: it's called from inside locked operations
// (setQuickNoteCardCategory, adoptQuickNoteCategories, saveQuickNote's path),
// and taking the same deck's lock again from in there would deadlock.
export async function ensureLocalQuickNotesSnapshot() {
  const deckId = getQuickNotesDeckId();
  if (!deckId) return null;
  const existing = await readLocalSnapshotByDeckId(deckId);
  if (existing) return existing;

  const localId = quickNotesLocalId(deckId);
  const now = new Date().toISOString();
  const snapshot = {
    app: "recall",
    version: 1,
    exportedAt: now,
    deckTitle: QUICK_NOTES_DECK_TITLE,
    deckCategory: defaultDeckCategory,
    notes: "",
    sourceTitle: QUICK_NOTES_DECK_TITLE,
    importTitleHint: QUICK_NOTES_DECK_TITLE,
    deckId,
    current: 0,
    meta: state.quickNoteCategories?.length ? { quickNoteCategories: state.quickNoteCategories } : {},
    cards: [],
    localDeckId: localId
  };
  writeDeckSnapshot(localId, snapshot);
  // A brand-new local deck with no cloud counterpart yet reads as "newer than
  // the cloud", which is what makes the next reconcile push it — including
  // creating the decks row, so ensureQuickNotesDeck is no longer needed on the
  // write path.
  const index = readLocalDeckIndex().filter((e) => e.id !== localId);
  writeLocalDeckIndex([{
    id: localId,
    title: QUICK_NOTES_DECK_TITLE,
    category: defaultDeckCategory,
    cardCount: 0,
    hasNotes: false,
    updatedAt: now,
    createdAt: now,
    lastSyncedAt: null,
    accessedAt: now,
    deckId
  }, ...index]);
  return { localId, snapshot };
}

// ── Category edits are OPERATIONS, not list replacements ─────────
// Saving the whole list is what makes two devices fight: A's list is a snapshot
// of what A could see, so writing it says "these are ALL the categories that
// exist" — silently deleting anything B added that A hadn't heard of yet. There
// is no way to tell "I never had Y" apart from "I deleted Y" in a bare list.
//
// An op says only what the user actually did, so it can be applied on top of
// whatever the cloud holds *now* and leaves every category it doesn't name
// alone. Deletion is explicit, so no tombstones are needed in the shared blob
// and its shape is unchanged.
//
//   { type: "upsert", id, fields: { name?, color? }, full: { id, name, color } }
//   { type: "delete", id }
//
// `fields` is only what changed, so A renaming a category can't revert B's
// concurrent recolour of it. `full` is the fallback used when the id isn't in
// the target list at all (B deleted it, or this is a fresh add).
export function categoryUpsertOp(category, fields) {
  return {
    type: "upsert",
    id: String(category.id),
    fields,
    full: { id: String(category.id), name: category.name, color: category.color }
  };
}

export function categoryDeleteOp(id) {
  return { type: "delete", id: String(id) };
}

// Replay ops onto a list. Pure, and the same function is used for the local
// list and the cloud's — so what you see locally is what the merge produces.
export function applyCategoryOpsToList(list, ops) {
  let out = normalizeQuickNoteCategories(list);
  for (const op of ops || []) {
    if (!op || !op.id) continue;
    if (op.type === "delete") {
      out = out.filter((c) => c.id !== op.id);
      continue;
    }
    const index = out.findIndex((c) => c.id === op.id);
    if (index === -1) {
      // Not there to patch: either a new category, or one another device
      // deleted. Re-inserting on a rename/recolour is deliberate — the user
      // just acted on it, so treat that as intent to keep it.
      out = [...out, { ...(op.full || {}), ...op.fields, id: op.id }];
    } else {
      out = out.map((c, i) => i === index ? { ...c, ...op.fields } : c);
    }
  }
  return normalizeQuickNoteCategories(out);
}

// Apply category edits locally — state + cache + snapshot mirror — and QUEUE
// them for the cloud. The cloud write no longer happens here: a rename or a
// recolour used to cost a read-merge-write round trip the moment you made it,
// which offline did nothing at all. The queue is delivered by the next
// reconcile, batched with every other pending change.
//
// Queuing the OPS (not the resulting list) is what lets the eventual replay
// merge with whatever other devices did in the meantime — see the header above
// categoryUpsertOp.
//
// Returns "queued" so callers can tell the user where the edit landed.
export async function applyQuickNoteCategoryOps(ops) {
  await adoptQuickNoteCategories(applyCategoryOpsToList(state.quickNoteCategories, ops));
  queuePendingQuickNoteCategoryOps(getQuickNotesDeckId(), ops);
  return "queued";
}

// The cloud half of applyQuickNoteCategoryOps. Always call it through
// serialiseQuickNoteMetaWrite — it read-merge-writes the shared meta blob.
export async function writeQuickNoteCategoryOpsToCloud(deckId, ops) {
  if (!supabaseClient || !isSignedIn || !navigator.onLine || !deckId) return "offline";
  try {
    // Merge into whatever meta the deck already has so we don't clobber future
    // sibling keys (noteAnchors above all — they live in the same blob).
    const { data: existing } = await supabaseClient.from("decks").select("meta").eq("id", deckId).maybeSingle();
    const base = existing?.meta && typeof existing.meta === "object" ? existing.meta : {};
    // Replay our ops onto the CLOUD's current list, not over the top of it.
    // This is the whole fix: a category another device added while we were
    // offline is in `base` and no op names it, so it survives untouched.
    const merged = applyCategoryOpsToList(quickNoteCategoriesFromMeta(base), ops);
    const meta = { ...base, quickNoteCategories: merged };
    let { data: updated, error } = await supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id");
    // By error code first, not by the word "meta" appearing anywhere in the
    // message — see isMissingColumnError. The loose check would read an
    // unrelated failure that happened to name the column as "the migration
    // hasn't run", discard the write, and report it as an ordinary local-only
    // outcome that nothing ever retries.
    if (error && isMissingColumnError(error, "meta")) {
      // Database hasn't run supabase_setup.sql — categories still work
      // locally; just can't sync until the column exists.
      console.warn("decks.meta column missing — quick-note categories are local-only until you run supabase_setup.sql");
      return "no-column";
    }
    if (error) throw error;
    // An UPDATE that matches no row is not an error — it just does nothing. On
    // an account that has never pinned a note the quick_notes deck row doesn't
    // exist yet (only the pin flow creates it), so this reported success while
    // saving nothing at all. `.select()` is what makes that case visible.
    if (!updated || !updated.length) {
      const userId = cachedUserId();
      if (!userId) return "failed";
      await ensureQuickNotesDeck(userId);
      ({ data: updated, error } = await supabaseClient.from("decks").update({ meta }).eq("id", deckId).select("id"));
      if (error) throw error;
      if (!updated || !updated.length) return "failed";
    }
    // The merge is authoritative now, so adopt it: it's our edit PLUS whatever
    // other devices had added. Without this the board would keep showing only
    // our own view until the next reload, and the following edit would be built
    // from a list already missing their categories.
    await adoptQuickNoteCategories(merged);
  } catch (error) {
    console.warn("Could not sync quick-note categories to cloud", error);
    return "failed";
  }
  return "synced";
}

// Point every local mirror of the category list at one list.
export async function adoptQuickNoteCategories(list) {
  const clean = normalizeQuickNoteCategories(list);
  state.quickNoteCategories = clean;
  writeCachedQuickNoteCategories(clean);
  const deckId = getQuickNotesDeckId();
  if (!deckId) return clean;
  // Locked: this read-modify-writes the quick_notes snapshot's meta bag, which
  // a pull of the same deck also rewrites. readLocalSnapshotByDeckId is
  // deliberately unlocked so it can be called from in here without deadlocking.
  await withDeckLock(quickNotesLocalId(deckId), async () => {
    const local = await readLocalSnapshotByDeckId(deckId);
    if (!local) return;
    local.snapshot.meta = { ...(local.snapshot.meta || {}), quickNoteCategories: clean };
    writeDeckSnapshot(local.localId, local.snapshot);
  });
  return clean;
}

// ── Pending category writes ──────────────────────────────────────
// Category edits made offline (or against a not-yet-created deck row) that
// still owe the cloud a write. Kept per deck id so signing in as someone else
// can never deliver the previous account's categories to the new one's deck.
//
// Stores OPS, not the resulting list. A queued list would say "these are all
// the categories that exist" and delete whatever another device added while
// this one was offline; a queued op only re-states what the user did.
export const PENDING_QN_CATEGORIES_KEY = "recall:pendingQuickNoteCategories";

export function readPendingQuickNoteCategories() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_QN_CATEGORIES_KEY) || "null");
    if (!raw) return null;
    if (Array.isArray(raw.ops)) {
      const ops = raw.ops.filter((op) => op && op.id && (op.type === "delete" || op.type === "upsert"));
      return ops.length ? { deckId: String(raw.deckId || ""), ops, savedAt: raw.savedAt || "" } : null;
    }
    // Older builds queued a whole list. Convert it to upserts so the edit still
    // lands — the deletions it implied are unrecoverable from a list, which is
    // exactly why this format is gone.
    if (Array.isArray(raw.categories)) {
      const ops = normalizeQuickNoteCategories(raw.categories)
        .map((c) => categoryUpsertOp(c, { name: c.name, color: c.color }));
      return ops.length ? { deckId: String(raw.deckId || ""), ops, savedAt: raw.savedAt || "" } : null;
    }
    return null;
  } catch {
    return null;
  }
}

// Appends to whatever is already queued: several offline edits must all be
// replayed, in order, or the earlier ones are lost.
export function queuePendingQuickNoteCategoryOps(deckId, ops) {
  const existing = readPendingQuickNoteCategories();
  const merged = existing && existing.deckId === (deckId || "") ? [...existing.ops, ...ops] : [...ops];
  try {
    localStorage.setItem(PENDING_QN_CATEGORIES_KEY, JSON.stringify({
      deckId: deckId || "", ops: merged, savedAt: new Date().toISOString()
    }));
  } catch (_) {}
}

export function clearPendingQuickNoteCategories() {
  try { localStorage.removeItem(PENDING_QN_CATEGORIES_KEY); } catch (_) {}
}

// Deliver queued category edits. Returns true only when something actually
// landed, so the sync report can say so. Safe to call on every sync: it's a
// no-op with nothing pending.
export async function flushPendingQuickNoteCategories() {
  const pending = readPendingQuickNoteCategories();
  if (!pending) return false;
  const deckId = getQuickNotesDeckId();
  if (!deckId) return false;
  // Queued against a different account's deck — not ours to deliver, and
  // pushing it would write one user's categories onto another's board.
  if (pending.deckId && pending.deckId !== deckId) {
    clearPendingQuickNoteCategories();
    return false;
  }
  const outcome = await serialiseQuickNoteMetaWrite(
    () => writeQuickNoteCategoryOpsToCloud(deckId, pending.ops)
  );
  // Only a confirmed write clears the queue. "no-column" is a permanent failure
  // for this database (the migration hasn't been run) but is still cleared —
  // replaying it forever on every sync would never succeed and the local copy
  // is already correct.
  if (outcome === "synced" || outcome === "no-column") clearPendingQuickNoteCategories();
  return outcome === "synced";
}
