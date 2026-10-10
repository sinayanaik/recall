// What the deck on screen was, when this window last agreed with the disk.
//
// One per window, for the one deck it has open. `rev` is the store revision of
// the copy it loaded or last wrote (see nextDeckRev), `loaded` that copy itself
// (the fallback test for a snapshot written before revisions existed), and
// `snapshot` the deck as this window's own `state` described it at that moment —
// the common ancestor its later edits are edits OF. A save that finds a
// different revision on disk merges against this instead of overwriting.

let openBase = null;

function cloneForBase(value) {
  if (!value) return null;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

export function setOpenDeckBase(localId, { rev = null, loaded = null, snapshot = null } = {}) {
  if (!localId || (openBase && openBase.localId !== String(localId))) recentRevisions.clear();
  openBase = localId ? { localId: String(localId), rev, loaded: cloneForBase(loaded), snapshot: cloneForBase(snapshot) } : null;
  if (localId && rev && snapshot) rememberRevision(rev, snapshot);
}

// ── The last few revisions this window has known ───────────────────────────
//
// A merge needs the common ancestor of the two copies. Usually that is the
// base above. But a copy written by another window from an OLDER revision —
// one it still held in its cache when it was hidden a moment after this window
// saved — branched from before this window's last save, and merging it against
// the base would read that save as undone. So the window keeps the deck as it
// was at its last few revisions, and the merge looks the other copy's parent up
// here. Bounded, and dropped whenever another deck is opened.
const RECENT_REVISIONS_MAX = 8;
const recentRevisions = new Map();

export function rememberRevision(rev, snapshot) {
  if (!rev || !snapshot) return;
  recentRevisions.delete(rev);
  recentRevisions.set(rev, cloneForBase(snapshot));
  while (recentRevisions.size > RECENT_REVISIONS_MAX) recentRevisions.delete(recentRevisions.keys().next().value);
}

export function revisionContent(rev) {
  return (rev && recentRevisions.get(rev)) || null;
}

export function openDeckBase(localId) {
  return openBase && localId && openBase.localId === String(localId) ? openBase : null;
}

export function clearOpenDeckBase() {
  openBase = null;
  recentRevisions.clear();
}
