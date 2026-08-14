// Per-card merge, and the tombstones that make a deletion stick.
//
// The sync merges PER CARD on updated_at, not per deck: deck-level
// last-write-wins meant two devices editing different cards in one deck
// silently discarded one side's work.
//
// Deletions need tombstones because absence is ambiguous — a card that is gone
// locally and present in the cloud is either a deletion to push or a creation
// to pull, and nothing in the rows themselves says which.

import { normalizeCardStatus } from "../export/markdown.js?v=__BUILD__";
import { normalizeSyncText } from "./diff.js?v=__BUILD__";
import { tsMs } from "./stats.js?v=__BUILD__";

// ── Per-card delete tombstones ──────────────────────────────────────────────
// `dirty` alone cannot express "I deleted this card": a deleted card leaves no
// object behind to carry a flag. That gap is what let deletions un-happen. The
// push is authoritative (pushDeckRowsToCloud prunes every cloud card missing
// from the snapshot it sends), and the direction is chosen per deck purely by
// timestamp — so a device holding a stale copy of a deck it has ALSO edited
// takes the push branch, never pulls, and re-upserts the card another device
// deleted. The card then comes back on every device on their next pull.
//
// So each snapshot carries `deletedCardIds` — { cardId: iso } — the ids this
// device deleted. Two rules use it:
//   push : a cloud card absent locally is pruned only if it is tombstoned here.
//          Otherwise it was ADDED on another device, and pruning it would be
//          the same bug pointing the other way.
//   pull : a cloud row that is tombstoned here is not re-adopted; the deck is
//          marked as owing a push so the deletion is re-asserted in the cloud.
// A tombstone is retired as soon as the cloud is observed not to have that id —
// the deletion has propagated and nothing can resurrect it (a device still
// holding the card clean drops it under the clean-and-absent rule). The age cap
// is only a backstop for a device that never syncs again.
export const CARD_TOMBSTONE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;

export const CARD_TOMBSTONE_MAX = 2000;

// Always a fresh plain object, so callers can mutate it without touching the
// snapshot they read it from.
export function readCardTombstones(snapshot) {
  const raw = snapshot?.deletedCardIds;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, iso] of Object.entries(raw)) {
    if (id) out[String(id)] = typeof iso === "string" ? iso : new Date(0).toISOString();
  }
  return out;
}

// Age + count cap, so a deck that is edited for years can't grow an unbounded
// tombstone map inside a snapshot that has to fit in localStorage. Oldest go
// first when over the count cap.
export function pruneCardTombstones(map) {
  const cutoff = Date.now() - CARD_TOMBSTONE_MAX_AGE_MS;
  let entries = Object.entries(map).filter(([, iso]) => tsMs(iso) >= cutoff);
  if (entries.length > CARD_TOMBSTONE_MAX) {
    entries.sort((a, b) => tsMs(b[1]) - tsMs(a[1]));
    entries = entries.slice(0, CARD_TOMBSTONE_MAX);
  }
  return Object.fromEntries(entries);
}

// The invariant every writer has to keep: a card that is PRESENT is not
// deleted. Snapshot paths that add cards by hand (a restore, a quick note
// pinned into another deck) must call this, or a re-created id would keep a
// tombstone that quietly blocks it from ever syncing again.
export function dropTombstonesForLiveCards(snapshot) {
  const map = readCardTombstones(snapshot);
  if (!Object.keys(map).length) return snapshot;
  for (const card of snapshot.cards || []) delete map[String(card.id)];
  if (Object.keys(map).length) snapshot.deletedCardIds = map;
  else delete snapshot.deletedCardIds;
  return snapshot;
}

// Carries a deck's tombstones across a save: ids that were in the copy being
// replaced but aren't in the new one were just deleted here; ids that are back
// (an undo, or a re-import of the same card id) retire their tombstone, because
// the user's most recent action is the one that counts.
export function recordDeletedCardIds(snapshot, previousSnapshot, stampIso) {
  const map = readCardTombstones(previousSnapshot);
  const liveIds = new Set((snapshot.cards || []).map((card) => String(card.id)));
  for (const card of previousSnapshot?.cards || []) {
    const id = String(card.id || "");
    if (id && !liveIds.has(id)) map[id] = stampIso;
  }
  const pruned = pruneCardTombstones(map);
  snapshot.deletedCardIds = pruned;
  return dropTombstonesForLiveCards(snapshot);
}

// The fields that make a card materially different — i.e. the ones worth
// pushing. Deliberately excludes position (tracked by the deck's card order)
// and noteAnchor (device-local; the cards table has no column for it).
export function cardSyncSignature(card) {
  return [
    normalizeSyncText(card?.question),
    normalizeSyncText(card?.answer),
    normalizeCardStatus(card?.status),
    card?.category || ""
  ].join("␟");
}

export function cardIsDirty(card) {
  return Boolean(card && card.dirty);
}

// A card's local edit time, falling back to the deck's timestamp for snapshots
// written before per-card stamps existed.
export function cardUpdatedMs(card, fallbackIso) {
  return tsMs(card?.updatedAt || fallbackIso);
}

// Stamps dirty/updatedAt onto a freshly built snapshot by diffing it against the
// copy it is about to replace. Called from saveDeckToLibrary — the one choke
// point every local deck edit passes through. A card whose content is unchanged
// keeps its previous flags, so a card still waiting to be pushed stays dirty
// across any number of unrelated saves. `synced` is for the one case where the
// snapshot is known to match the cloud already (mirroring a just-loaded web
// deck): everything is clean, and nothing gets re-pushed for no reason.
export function stampCardSyncState(snapshot, previousSnapshot, stampIso, { synced = false } = {}) {
  const previousById = new Map(
    (previousSnapshot?.cards || []).map((card) => [String(card.id), card])
  );
  for (const card of snapshot.cards || []) {
    if (synced) {
      card.dirty = false;
      card.updatedAt = stampIso;
      continue;
    }
    const previous = previousById.get(String(card.id));
    if (previous && cardSyncSignature(previous) === cardSyncSignature(card)) {
      card.dirty = cardIsDirty(previous);
      card.updatedAt = previous.updatedAt || stampIso;
    } else {
      card.dirty = true;
      card.updatedAt = stampIso;
    }
  }
  return snapshot;
}

// Merge one deck's incoming cloud rows into the copy this device already holds,
// card by card, instead of replacing the list:
//
//   local only, dirty         → keep   (added here, never pushed)
//   local only, clean         → drop   (it reached the cloud once, so the cloud
//                                       no longer having it IS a deletion)
//   in both, local dirty AND
//     strictly newer          → keep local
//   in both, otherwise        → take cloud (and it is clean from now on)
//   cloud only                → add
//
// Result order follows the cloud's row order (already sorted by `position`),
// with kept local-only cards appended in their existing relative order — they
// have no cloud position to slot into yet. `keptLocal` is what tells the caller
// this deck still owes the cloud a push after the pull, and so is
// `blockedResurrections` — a cloud row this device has tombstoned is skipped
// here and has to be re-deleted in the cloud by the following push.
export function mergeCloudCardsIntoSnapshot(oldSnapshot, cloudCards, deckFallbackIso) {
  const localCards = Array.isArray(oldSnapshot?.cards) ? oldSnapshot.cards : [];
  const localById = new Map(localCards.map((card) => [String(card.id), card]));
  const tombstones = readCardTombstones(oldSnapshot);
  const merged = [];
  const seenLocalIds = new Set();
  const cloudIds = new Set();
  let keptLocal = 0;
  let blockedResurrections = 0;

  for (const row of cloudCards || []) {
    const id = String(row.id || "");
    if (!id) continue;
    cloudIds.add(id);
    // Deleted here, still in the cloud — another device re-pushed it, or our own
    // delete hasn't been pushed yet. Either way, adopting it back is exactly the
    // resurrection this tombstone exists to stop.
    if (tombstones[id]) {
      blockedResurrections += 1;
      continue;
    }
    const local = localById.get(id);
    const fromCloud = {
      id,
      question: row.question,
      answer: row.answer,
      status: normalizeCardStatus(row.status),
      category: row.category ? String(row.category) : null,
      dirty: false,
      updatedAt: row.updated_at || deckFallbackIso
    };
    if (local) {
      seenLocalIds.add(id);
      if (cardIsDirty(local) && cardUpdatedMs(local, deckFallbackIso) > tsMs(row.updated_at || deckFallbackIso)) {
        keptLocal += 1;
        merged.push({ ...local, id });
        continue;
      }
      // noteAnchor is a device-local link (the cloud `cards` table has no column
      // for it), so an incoming row never carries one. Re-attach what this
      // device already had, or every pull permanently breaks the quick-note
      // "jump to where this was pinned" button.
      if (local.noteAnchor) fromCloud.noteAnchor = local.noteAnchor;
    }
    merged.push(fromCloud);
  }

  // Zero cloud rows for a deck that has cards here is NOT read as "every card
  // was deleted elsewhere". It is what an unauthenticated read looks like (RLS
  // returns an empty set, not an error), and what a dropped page looks like —
  // and the cost of believing it is the entire deck, here and then in the cloud
  // on the next push. A deck genuinely emptied on another device still converges:
  // that device holds per-card tombstones and re-deletes these rows, which is
  // the evidence-based path. This only refuses the guess.
  const cloudLooksBlank = !(cloudCards || []).length && localCards.length > 0;

  for (const card of localCards) {
    const id = String(card.id || "");
    if (!id || seenLocalIds.has(id)) continue;
    // Clean and cloud-less means it was synced once and deleted elsewhere —
    // dropping it is the whole point of a two-way mirror. Only unpushed work
    // survives a cloud that has never heard of it.
    if (!cardIsDirty(card) && !cloudLooksBlank) continue;
    keptLocal += 1;
    merged.push({ ...card, id });
  }
  if (cloudLooksBlank) {
    console.warn(`Cloud returned 0 cards for a deck holding ${localCards.length} — keeping them all rather than treating it as a deletion.`);
  }

  // Retire the tombstones the cloud has already honoured. Keeping them past
  // that point would block a card the user later re-creates with the same id
  // (a restore from backup, say) from ever syncing again.
  const deletedCardIds = pruneCardTombstones(
    Object.fromEntries(Object.entries(tombstones).filter(([id]) => cloudIds.has(id)))
  );

  return { cards: merged, keptLocal, blockedResurrections, deletedCardIds };
}

// The push side of the same story. `pushLibraryDeckToCloud` sends the local card
// list and pushDeckRowsToCloud deletes every cloud row missing from it — which is
// only correct if the local list is a superset of "what the cloud has, minus what
// I deleted". This makes it one, using the deck's cloud rows (already fetched for
// the push diff) as the reference:
//
//   local, in cloud            → push
//   local only, dirty          → push   (added/edited here, cloud hasn't seen it)
//   local only, clean          → DROP   (it reached the cloud once and is gone
//                                        from it now — deleted on another device)
//   cloud only, tombstoned here → omit  (deleted here; the push prunes it)
//   cloud only, not tombstoned  → adopt (added on another device since our last
//                                        pull; pushing without it would delete
//                                        someone else's new card)
//
// Adopted rows are appended rather than slotted in at their cloud position: the
// push restamps positions from array order anyway, and appending keeps this
// device's own ordering intact.
export function reconcileCardsBeforePush(snapshot, cloudCards) {
  const localCards = Array.isArray(snapshot?.cards) ? snapshot.cards : [];
  const tombstones = readCardTombstones(snapshot);
  const cloudById = new Map((cloudCards || []).map((row) => [String(row.id), row]));
  const localIds = new Set(localCards.map((card) => String(card.id)));

  // Dropping a clean local-only card only means "deleted elsewhere" if this
  // snapshot actually carries per-card sync state. A snapshot written by a build
  // that predates it has no `dirty` anywhere, so every card would read as clean
  // and a legitimately-unpushed card would be destroyed instead of uploaded.
  // Keep everything in that case; the push itself writes the fields back, so a
  // deck is legacy for exactly one sync.
  const hasCardSyncState = localCards.some((card) => card.dirty !== undefined || card.updatedAt);

  // The same refusal as the pull side (see mergeCloudCardsIntoSnapshot): a deck
  // whose cloud rows all came back empty is far more likely to be a bad read
  // than a deck someone emptied card by card — and here the stakes are higher
  // still, because these cards are about to be dropped from the snapshot AND
  // the push that follows prunes whatever it doesn't send. Believing a blank
  // read at this point deletes the deck's contents on every device at once.
  const cloudLooksBlank = !(cloudCards || []).length && localCards.length > 0;

  const cards = [];
  let dropped = 0;
  for (const card of localCards) {
    const id = String(card.id || "");
    if (!id) continue;
    if (hasCardSyncState && !cloudLooksBlank && !cloudById.has(id) && !cardIsDirty(card)) {
      dropped += 1;
      continue;
    }
    cards.push(card);
  }
  if (cloudLooksBlank) {
    console.warn(`Push diff saw 0 cloud cards for a deck holding ${localCards.length} — sending them all rather than pruning.`);
  }

  let adopted = 0;
  for (const row of cloudCards || []) {
    const id = String(row.id || "");
    if (!id || localIds.has(id) || tombstones[id]) continue;
    adopted += 1;
    cards.push({
      id,
      question: row.question,
      answer: row.answer,
      status: normalizeCardStatus(row.status),
      category: row.category ? String(row.category) : null,
      dirty: false,
      updatedAt: row.updated_at || new Date().toISOString()
    });
  }

  // Same retirement rule as the pull: a tombstone whose card is no longer in the
  // cloud has done its job.
  const deletedCardIds = pruneCardTombstones(
    Object.fromEntries(Object.entries(tombstones).filter(([id]) => cloudById.has(id)))
  );

  return { cards, dropped, adopted, deletedCardIds };
}
