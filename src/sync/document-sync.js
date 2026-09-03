// A paper's annotations, merged the way a deck's cards already are.
//
// src/sync/cards.js gave a CARD four things, and between them they are why two
// devices can edit one deck all day and lose nothing: a per-row timestamp, a
// merge on the pull (mergeCloudCardsIntoSnapshot), a reconcile against the
// cloud's real rows before the push (reconcileCardsBeforePush), and a tombstone
// that makes a deletion stick.
//
// A DOCUMENT's annotations had almost none of it, and the failure was
// deterministic rather than a race:
//
//   • a highlight is a record in meta.pdfHighlights, and the pull did merge
//     those by id — but the push sent `meta` whole, so a device that pushed
//     without having pulled overwrote the cloud's highlights with its own;
//   • a highlight's NOTE is worse: its text lives in the fenced block at the end
//     of `notes`, and `notes` was last-write-wins on BOTH sides. Nothing merged
//     it at all;
//   • a deletion was recorded nowhere, so the only thing that made a deleted
//     highlight stay deleted was that same clobber.
//
// Device A annotates and pushes. Device B has a local edit stamped later, so the
// reconcile's pull gate (cloud.updated_at > local.updatedAt) skips B's pull
// entirely and B pushes its whole `notes` and `meta` over A's. On A's next sync
// the highlights come back — the pull merges those — but the note text does not:
// A's fenced block is replaced by B's, syncTextChanged fires, and because on a
// PDF deck the notes body is essentially ONLY that block, every sync between two
// annotating devices tripped the conflict stash as well.
//
// This module is the missing half. It is the document's reconcileCardsBeforePush
// and the document's tombstone bag, written in the same idioms and reusing the
// same helpers rather than paralleling them.
//
// The reader's OWN notes body is deliberately not merged here and stays
// last-write-wins with the existing stash and resolver: merging free prose
// written on two devices is a different problem, and src/sync/notes-conflict.js
// already answers it. What changes is that the fenced highlight-note block stops
// counting as a body difference at all.

import {
  joinHighlightNotesTail,
  splitHighlightNotesTail
} from "../format/notes-fence.js?v=__BUILD__";
import { mergeHighlightNoteTails } from "../format/highlight-notes-merge.js?v=__BUILD__";
import { CARD_TOMBSTONE_MAX_AGE_MS } from "./cards.js?v=__BUILD__";
import { mergePdfHighlights, mergeRecordsById } from "./diff.js?v=__BUILD__";
import { tsMs } from "./stats.js?v=__BUILD__";

// ── Deleted-highlight tombstones ────────────────────────────────────────────
//
// meta.deletedHighlightIds = { [id]: iso }, mirroring snapshot.deletedCardIds
// exactly — same shape, same age cap, same "a record that is PRESENT is not
// deleted" invariant. It rides in the deck's meta bag rather than at the top of
// the snapshot because that is where the highlights it is about already live,
// and because meta is what the push actually sends.
//
// Smaller count cap than the cards': these ride inside a JSONB column that is
// re-sent whole on every push, and a reader who deletes two thousand highlights
// from one paper is not a case worth carrying a kilobyte for on every sync.
export const HIGHLIGHT_TOMBSTONE_MAX = 500;

// Always a fresh plain object, so callers can mutate it without touching the
// meta bag they read it from.
export function readHighlightTombstones(meta) {
  const raw = meta?.deletedHighlightIds;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, iso] of Object.entries(raw)) {
    if (id) out[String(id)] = typeof iso === "string" ? iso : new Date(0).toISOString();
  }
  return out;
}

// Age + count cap, so a paper annotated for years can't grow an unbounded map
// inside a meta bag that has to fit in localStorage AND in every push. Oldest go
// first when over the count cap. Shares the cards' horizon: a device that has
// been offline longer than that has bigger problems than one stale highlight.
export function pruneHighlightTombstones(map) {
  const cutoff = Date.now() - CARD_TOMBSTONE_MAX_AGE_MS;
  let entries = Object.entries(map).filter(([, iso]) => tsMs(iso) >= cutoff);
  if (entries.length > HIGHLIGHT_TOMBSTONE_MAX) {
    entries.sort((a, b) => tsMs(b[1]) - tsMs(a[1]));
    entries = entries.slice(0, HIGHLIGHT_TOMBSTONE_MAX);
  }
  return Object.fromEntries(entries);
}

// The write path, called from removeDocumentHighlight. Returns the new map
// rather than mutating `meta`, because every writer of state.meta in this app
// replaces the bag rather than editing it in place.
export function recordDeletedHighlightId(meta, id, stampIso = new Date().toISOString()) {
  const map = readHighlightTombstones(meta);
  if (id) map[String(id)] = stampIso;
  return pruneHighlightTombstones(map);
}

// The invariant every writer has to keep: a highlight that is PRESENT is not
// deleted. Without this an id that comes back — an undo, a re-import of the same
// annotated file — would keep a tombstone that quietly blocks it from ever
// syncing again. Returns the map, or null when there is nothing left to store.
export function dropHighlightTombstonesForLiveIds(meta, records) {
  const map = readHighlightTombstones(meta);
  if (!Object.keys(map).length) return null;
  for (const record of records || []) delete map[String(record?.id)];
  return Object.keys(map).length ? map : null;
}

// The two sides' tombstones as one { id: ms } map, newest kept. `ms` rather than
// iso because everything downstream compares it against a record's `at`, which
// is a Date.now().
export function highlightTombstoneMs(...metas) {
  const out = {};
  for (const meta of metas) {
    for (const [id, iso] of Object.entries(readHighlightTombstones(meta))) {
      const ms = tsMs(iso);
      if (ms > (out[id] || 0)) out[id] = ms;
    }
  }
  return out;
}

// The union again, but back in the { id: iso } form that gets stored and pushed.
export function mergeHighlightTombstones(...metas) {
  const out = {};
  for (const meta of metas) {
    for (const [id, iso] of Object.entries(readHighlightTombstones(meta))) {
      if (!out[id] || tsMs(iso) > tsMs(out[id])) out[id] = iso;
    }
  }
  return pruneHighlightTombstones(out);
}

// Every record's note stamp, for mergeHighlightNoteTails. A record with no
// noteAt contributes nothing, which is what makes it read as older.
export function highlightNoteStamps(records) {
  const out = {};
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.id && record.noteAt) out[String(record.id)] = Number(record.noteAt);
  }
  return out;
}

// ── The merge both directions share ─────────────────────────────────────────
//
// `body` says whose reader-prose wins, and it is the ONLY thing that differs
// between the two callers: the pull takes the cloud's body (unchanged
// behaviour — the stash catches what that replaces), the push takes this
// device's, because that is what it is about to send. The annotations are merged
// identically either way.
//
// `extraTails` is for the conflict stash: a device that has been diverging for a
// while has annotations stranded in it, and folding it in as one more source is
// what recovers them.
export function mergeDocumentAnnotations({
  cloudNotes = "",
  cloudMeta = null,
  localNotes = "",
  localMeta = null,
  body = "cloud",
  extraTails = []
} = {}) {
  const cloudRecords = Array.isArray(cloudMeta?.pdfHighlights) ? cloudMeta.pdfHighlights : null;
  const localRecords = Array.isArray(localMeta?.pdfHighlights) ? localMeta.pdfHighlights : null;
  const tombstoneMs = highlightTombstoneMs(cloudMeta, localMeta);
  const pdfHighlights = mergePdfHighlights(cloudRecords, localRecords, { tombstones: tombstoneMs });

  const cloudSplit = splitHighlightNotesTail(String(cloudNotes || ""));
  const localSplit = splitHighlightNotesTail(String(localNotes || ""));
  const stamps = { cloud: highlightNoteStamps(cloudRecords), local: highlightNoteStamps(localRecords) };

  // The stash is folded in FIRST, against this device's own tail, so the pair
  // that reaches the cloud/local merge already holds everything this device has
  // ever had. Its entries carry no stamp of their own, so a genuine difference
  // keeps both texts rather than picking one — which is the only safe answer for
  // text that was stashed precisely because nothing could choose.
  let localTail = localSplit.tail;
  for (const extra of extraTails) {
    if (!String(extra || "").trim()) continue;
    localTail = mergeHighlightNoteTails(localTail, String(extra), {
      stamps: { cloud: stamps.local, local: {} },
      tombstones: tombstoneMs
    }).tail;
  }

  const tail = mergeHighlightNoteTails(cloudSplit.tail, localTail, { stamps, tombstones: tombstoneMs });
  const chosenBody = body === "local" ? localSplit.body : cloudSplit.body;
  const notes = joinHighlightNotesTail(chosenBody, tail.tail);

  const localIds = new Set((localRecords || []).map((record) => String(record?.id)));
  const highlightsAdopted = (pdfHighlights || []).filter((record) => !localIds.has(String(record.id))).length;
  const highlightsRemoved = Math.max(0, (localRecords || []).length - (pdfHighlights || []).filter((record) => localIds.has(String(record.id))).length);

  return {
    notes,
    body: chosenBody,
    tail: tail.tail,
    pdfHighlights,
    deletedHighlightIds: mergeHighlightTombstones(cloudMeta, localMeta),
    highlightsAdopted,
    highlightsRemoved,
    highlightNotesMerged: tail.merged,
    highlightNotesAdopted: tail.adopted
  };
}

// ── Handwriting: the pages of a notebook, and the boxes on them ────────────
//
// meta.pages and meta.textBoxes are id'd records with their own `at`, exactly
// like the highlights on a paper — so they merge through the same function and
// keep the same invariant, which is why mergeRecordsById exists under that name
// in src/sync/diff.js rather than being copied here.
//
// The tombstone bags are the half that a union of live records alone cannot do:
// a page deleted on one device is, to the other device, simply a page it still
// has, and every sync would put it back. Same shape as deletedHighlightIds
// ({ id: iso }), same cap, same "a record that is PRESENT is not deleted".
export const HANDWRITING_META_KEYS = [
  { records: "pages", tombstones: "deletedPageIds" },
  { records: "textBoxes", tombstones: "deletedTextBoxIds" }
];

// Read / prune / record / drop, for any { id: iso } bag on the meta. The
// highlight functions above are these with the key filled in; keeping one
// implementation is what stops the pages' bag growing a subtly different cap or
// a subtly different age rule six months from now.
export function readMetaTombstones(meta, key) {
  const raw = meta?.[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, iso] of Object.entries(raw)) {
    if (id) out[String(id)] = typeof iso === "string" ? iso : new Date(0).toISOString();
  }
  return out;
}

export function recordDeletedMetaId(meta, key, id, stampIso = new Date().toISOString()) {
  const map = readMetaTombstones(meta, key);
  if (id) map[String(id)] = stampIso;
  return pruneHighlightTombstones(map);
}

export function dropMetaTombstonesForLiveIds(meta, key, records) {
  const map = readMetaTombstones(meta, key);
  if (!Object.keys(map).length) return null;
  for (const record of records || []) delete map[String(record?.id)];
  return Object.keys(map).length ? map : null;
}

function metaTombstoneMs(key, ...metas) {
  const out = {};
  for (const meta of metas) {
    for (const [id, iso] of Object.entries(readMetaTombstones(meta, key))) {
      const ms = tsMs(iso);
      if (ms > (out[id] || 0)) out[id] = ms;
    }
  }
  return out;
}

function mergeMetaTombstones(key, ...metas) {
  const merged = {};
  for (const meta of metas) {
    for (const [id, iso] of Object.entries(readMetaTombstones(meta, key))) {
      if (tsMs(iso) > tsMs(merged[id] || 0)) merged[id] = iso;
    }
  }
  const pruned = pruneHighlightTombstones(merged);
  return Object.keys(pruned).length ? pruned : null;
}

// Two devices that both added a page have both given a page the same `order`,
// so `order` alone is not a total order and the two would disagree about which
// came first. The id breaks the tie the same way on every device, and the run is
// renumbered afterwards so the stack a reader sees is 0..n-1 with no gaps.
function orderMergedPages(pages) {
  return pages
    .slice()
    .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0) || String(a?.id).localeCompare(String(b?.id)))
    .map((page, index) => (Number(page?.order) === index ? page : { ...page, order: index }));
}

// ── The rest of the meta bag ────────────────────────────────────────────────
//
// decks.meta is ONE JSONB column shared by six unrelated features, and
// pushDeckRowsToCloud sends it whole. So a push overwrites every key in it with
// whatever this device happens to hold — and this device pushes precisely
// BECAUSE its updated_at is newer, which is the case where it may not have
// pulled the others' work yet.
//
// The app already knows this is dangerous and already works around it where it
// noticed: serialiseQuickNoteMetaWrite (src/quick-notes/anchors.js) is a narrow
// read-merge-write of exactly one key, written that way so a category cannot
// clobber its neighbours. A whole-column deck push then undoes the careful thing
// it did. (There was a second such writer, pushBookmarkNow, for the same reason
// — removed once the bookmark stopped being a button of its own and became
// something the sync itself captures, at which point the run that wrote it was
// always the run about to push it. See src/notes/bookmark.js.)
//
// What that costs, key by key, on the ordinary "two devices, one deck" story:
//
//   • pdf        — attach a paper on the laptop, and the next push from the
//                  phone deletes meta.pdf from the cloud. The HIGHLIGHTS survive,
//                  because those are merged; the document they are positions in
//                  does not, so every device that pulls afterwards has a paper's
//                  worth of annotations and no paper. This is the worst of them.
//   • bookmark   — the place you kept, replaced by the place this device kept.
//   • quickNoteCategories, noteAnchors — a subject renamed or a note pinned on
//                  the other device, gone.
//   • linkIds    — the pull UNIONS these (see noteLinkAliasesFor in
//                  src/sync/reconcile.js); the push sends this device's alone, so
//                  the cloud's union shrinks and [[links]] written elsewhere stop
//                  resolving.
//   • readingPosition — settled by whoever pushed last rather than by its own
//                  `at`, which is the stamp it carries for exactly this purpose.
//
// The full cloud row is already in hand on both sides — fetchCloudDeckRows does
// select("*") and both pullCloudDeckIntoLibraryLocked and pushLibraryDeckToCloud
// are handed the result — so this costs no extra request.
//
// `prefer` is the side that wins a key nobody has a rule for, and it is the ONLY
// thing that differs between the two callers: "local" on the push (this device
// is the one sending), "cloud" on the pull (the cloud row is the newer one).
// Keeping the default that way preserves each direction's existing behaviour for
// every key not named below; the rules ARE the exceptions, where "whoever synced
// last" is the wrong answer.
//
// The pull needs it as much as the push does. Its meta was `{ ...cloudMeta }`
// with linkIds unioned back on — so a bookmark set on this device while offline,
// or a paper attached here and not yet pushed, was destroyed by the next pull
// exactly as the push destroyed the other device's.
//
// Deliberately implemented here rather than by importing the canonical helpers:
// noteLinkAliasesFor pulls in src/notes/link-picker.js and the category
// normaliser pulls in the whole cloud/board subtree, and this module is
// string-and-object work by design so tools/document-sync-check.mjs can drive it
// straight from Node with no browser. The shapes are named beside each rule.
// Key-sorted, because the only thing this is ever used for is "did anything
// actually move" — and a plain JSON.stringify answers that with the KEY ORDER as
// well as the content. The two bags being compared come from different places (a
// JSONB column parsed out of a network response, and a snapshot read back from
// IndexedDB) and the merge rebuilds one of them by spreading, so identical
// content in a different order is the ordinary case, not the exotic one. Getting
// it wrong means `changed` is true on every sync and every deck's snapshot is
// rewritten for nothing — pure quota churn on the device where quota is already
// the binding constraint.
function stableJson(value) {
  return JSON.stringify(value, (_key, val) => (
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val
  ));
}

export function mergeDeckMeta(cloudMeta, localMeta, { prefer = "local" } = {}) {
  const cloud = cloudMeta && typeof cloudMeta === "object" ? cloudMeta : {};
  const local = localMeta && typeof localMeta === "object" ? localMeta : {};
  const winner = prefer === "cloud" ? cloud : local;
  const loser = prefer === "cloud" ? local : cloud;
  const next = { ...loser, ...winner };

  // meta.pdf — only ever written, never deleted: "Remove from cloud" sets
  // offloaded:true and leaves the record (see offloadCurrentDocument), because
  // the highlights are coordinates into that exact file and the deck has to keep
  // knowing which file. So a side that has one always beats a side that has
  // none, and the preferred side wins when both do.
  if (!winner.pdf && loser.pdf) next.pdf = loser.pdf;

  // meta.bookmark and meta.readingPosition — { offset, source, text, at }, or
  // the document shape { offset, pdfPage, ratio, text, at }. Both carry their
  // own `at` precisely so cross-device ordering is settled by when the reader
  // was there, not by which device synced first — and neither rule below looks
  // inside the anchor, which is what let the bookmark grow a second shape for
  // the Document view without a line changing here. Same rule
  // betterReadingPosition applies between the meta and the local store: a record
  // with no stamp reads as older than one that has one.
  for (const key of ["bookmark", "readingPosition"]) {
    const a = cloud[key];
    const b = local[key];
    if (a && b) next[key] = (Number(b.at) || 0) >= (Number(a.at) || 0) ? b : a;
    else next[key] = b || a || undefined;
    if (!next[key]) delete next[key];
  }

  // meta.linkIds — a sorted array of the ids this deck answers to, one minted per
  // device. Every device holds a piece of the truth, so a union is the only
  // correct answer, exactly as the pull side takes one. Not capped here:
  // noteLinkAliasesFor caps it on the way back in, and duplicating its limit is a
  // constant to keep in step for no gain.
  const linkIds = [...new Set([
    ...(Array.isArray(cloud.linkIds) ? cloud.linkIds : []),
    ...(Array.isArray(local.linkIds) ? local.linkIds : [])
  ].map((id) => String(id || "").trim()).filter(Boolean))].sort();
  if (linkIds.length) next.linkIds = linkIds;

  // meta.quickNoteCategories — [{ id, name, color }]. Union by id, with the
  // preferred side winning a genuine conflict, which is what
  // applyCategoryOpsToList arrives at for the same pair. A category ADDED on the
  // other device is the case that was being lost; a rename on both is a coin
  // toss either way.
  if (Array.isArray(cloud.quickNoteCategories) || Array.isArray(local.quickNoteCategories)) {
    const byId = new Map();
    for (const entry of Array.isArray(loser.quickNoteCategories) ? loser.quickNoteCategories : []) {
      if (entry?.id) byId.set(String(entry.id), entry);
    }
    for (const entry of Array.isArray(winner.quickNoteCategories) ? winner.quickNoteCategories : []) {
      if (entry?.id) byId.set(String(entry.id), entry);
    }
    next.quickNoteCategories = [...byId.values()];
  }

  // meta.noteAnchors — { [cardId]: anchor }, one entry per pinned note. A plain
  // key union: the anchors are per-card and two devices pinning different notes
  // is the ordinary case, not a conflict.
  if ((cloud.noteAnchors && typeof cloud.noteAnchors === "object")
      || (local.noteAnchors && typeof local.noteAnchors === "object")) {
    next.noteAnchors = { ...(loser.noteAnchors || {}), ...(winner.noteAnchors || {}) };
  }

  // meta.pages / meta.textBoxes — a notebook's paper and the markdown boxes on
  // it, with a tombstone bag each. Merged by id on `at`, exactly as the paper's
  // highlights are, because a page written on here and a page written on there
  // are an ADD each and not a conflict — and because the whole-column push means
  // last-write-wins would throw one of them away every time.
  for (const { records, tombstones } of HANDWRITING_META_KEYS) {
    const merged = mergeRecordsById(cloud[records], local[records], {
      tombstones: metaTombstoneMs(tombstones, cloud, local)
    });
    if (merged) next[records] = records === "pages" ? orderMergedPages(merged) : merged;
    else delete next[records];
    const bag = mergeMetaTombstones(tombstones, cloud, local);
    if (bag) next[tombstones] = bag;
    else delete next[tombstones];
  }

  return next;
}

// ── The push side ───────────────────────────────────────────────────────────
//
// The half that closes the window rather than repairing after it, and the exact
// counterpart of reconcileCardsBeforePush: pushLibraryDeckToCloud is already
// handed the deck's full cloud row (fetchCloudDeckRows does select("*")), so
// `cloudDeck.notes` and `cloudDeck.meta` are in hand for free, and it already
// runs the card reconcile against `webCards` for precisely this reason.
//
// Writes the merged result back into the snapshot as well as sending it. Without
// that, a device that pushes never picks up the other's work: its own push makes
// it the newest, so the next sync takes the push branch again and it stays
// behind forever while the cloud is correct.
//
// It used to return null for a deck with nothing document-shaped on either side,
// which meant an ordinary deck's `meta` went up whole and unmerged — see
// mergeDeckMeta for what that costs. It runs for every deck now and
// returns null only when the cloud row cannot be read from, in which case the
// caller must not push the column at all.
export function reconcileDeckBeforePush(snapshot, cloudDeck) {
  if (!snapshot || !cloudDeck) return null;
  // A row that arrived without a notes column tells us nothing about the cloud's
  // annotations, and merging against "" would delete every one of them. Same
  // discriminator, and the same refusal, as the pull side uses.
  if (!Object.prototype.hasOwnProperty.call(cloudDeck, "notes")) return null;
  const cloudMeta = cloudDeck.meta && typeof cloudDeck.meta === "object" ? cloudDeck.meta : {};
  const localMeta = snapshot.meta && typeof snapshot.meta === "object" ? snapshot.meta : {};
  const hasAnnotations = Array.isArray(cloudMeta.pdfHighlights) || Array.isArray(localMeta.pdfHighlights)
    || splitHighlightNotesTail(String(cloudDeck.notes || "")).tail
    || splitHighlightNotesTail(String(snapshot.notes || "")).tail;

  // Every key the two sides both have an opinion about, settled key by key.
  // Runs whether or not this is a paper: linkIds, the bookmark and the quick-note
  // categories belong to ordinary decks and were being lost on ordinary syncs.
  const nextMeta = mergeDeckMeta(cloudMeta, localMeta, { prefer: "local" });

  const merged = hasAnnotations
    ? mergeDocumentAnnotations({
      cloudNotes: String(cloudDeck.notes || ""),
      cloudMeta,
      localNotes: String(snapshot.notes || ""),
      localMeta,
      body: "local"
    })
    : null;

  if (merged?.pdfHighlights) nextMeta.pdfHighlights = merged.pdfHighlights;
  if (merged && Object.keys(merged.deletedHighlightIds).length) nextMeta.deletedHighlightIds = merged.deletedHighlightIds;
  else if (merged) delete nextMeta.deletedHighlightIds;

  // Ids this push is about to remove from the cloud on a tombstone's say-so.
  // Once it lands they have served their purpose and are retired — off the
  // RE-READ snapshot, one id at a time, so a highlight deleted while the push
  // was in flight keeps its own fresh tombstone.
  const cloudIds = new Set((cloudMeta.pdfHighlights || []).map((record) => String(record?.id)));
  const tombstonesBeingPruned = merged
    ? Object.keys(merged.deletedHighlightIds).filter((id) => cloudIds.has(id))
    : [];

  const notes = merged ? merged.notes : String(snapshot.notes || "");

  return {
    notes,
    meta: nextMeta,
    tombstonesBeingPruned,
    highlightsAdopted: merged?.highlightsAdopted || 0,
    highlightsRemoved: merged?.highlightsRemoved || 0,
    highlightNotesMerged: merged?.highlightNotesMerged || 0,
    highlightNotesAdopted: merged?.highlightNotesAdopted || 0,
    // Only when something actually moved. Most syncs change nothing here, and
    // rewriting every deck's snapshot on every sync is pure quota churn on the
    // device where quota is already the binding constraint — the same rule
    // reconcileCardsBeforePush follows. Compared over the WHOLE bag now, not
    // three of its keys, because the merge above can move any of them — and
    // key-sorted, or the spread that rebuilt the bag would report every deck as
    // changed on every sync purely for reordering its own keys.
    changed: notes !== String(snapshot.notes || "")
      || stableJson(nextMeta) !== stableJson(localMeta)
  };
}
