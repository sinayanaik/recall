// Putting one window's edits on top of a deck that moved underneath it.
//
// Every save used to build the whole deck from this tab's memory and write it
// over whatever was on disk. That is only right if nothing else wrote in
// between, and plenty does: the same deck open in a second window or tab, a
// sync pulling another device's work into it, a quick note pinned from
// elsewhere. Writing the stale copy back silently undid all of them — and,
// worse, read every card this window had never seen as "deleted here", so the
// next sync deleted it from the cloud too.
//
// So a save is a three-way merge, exactly like the sync's:
//
//   base    what this window loaded (or last saved) — the copy its edits are
//           edits OF
//   mine    what this window holds now
//   theirs  what is on disk now
//
// Whatever this window did not touch takes the disk's version; whatever only
// this window changed is kept; whatever both changed is merged (notes line by
// line and word by word, cards and records by id, objects key by key). A
// deletion only counts if this window actually removed something that was in
// its base.
//
// Pure: no store, no state, no DOM. tools/sync-reconcile-check.mjs drives it.

import { joinHighlightNotesTail, splitHighlightNotesTail } from "../format/notes-fence.js?v=__BUILD__";
import { mergeText, mergeValues, sameValue } from "./merge3.js?v=__BUILD__";

// The fields of a card that are the reader's content. dirty/updatedAt/syncBase
// are the sync's bookkeeping about that content, and comparing them would make
// every card read as edited by whichever side carries them.
export function cardContent(card) {
  const out = {
    id: String(card?.id ?? ""),
    question: String(card?.question ?? ""),
    answer: String(card?.answer ?? ""),
    status: card?.status || null,
    category: card?.category ? String(card.category) : null
  };
  if (card?.noteAnchor && typeof card.noteAnchor === "object") out.noteAnchor = card.noteAnchor;
  return out;
}

// The parts of a snapshot that are the deck. Everything else on a stored
// snapshot (rev, syncedNotesBase, deletedCardIds, exportedAt…) belongs to the
// store or the sync and is carried from the disk copy, never merged.
export function snapshotContent(snapshot) {
  const s = snapshot || {};
  return {
    deckTitle: String(s.deckTitle ?? ""),
    deckCategory: s.deckCategory ?? null,
    notes: String(s.notes ?? ""),
    sourceTitle: String(s.sourceTitle ?? ""),
    importTitleHint: String(s.importTitleHint ?? ""),
    deckId: s.deckId ?? null,
    current: Number.isFinite(Number(s.current)) ? Number(s.current) : 0,
    meta: s.meta && typeof s.meta === "object" ? s.meta : {},
    cards: Array.isArray(s.cards) ? s.cards.map(cardContent) : []
  };
}

export function sameDeckContent(a, b) {
  return sameValue(snapshotContent(a), snapshotContent(b));
}

// Returns {
//   snapshot      the merged deck: `theirs` with every content field replaced
//                 by the merge, so the store's own fields ride along untouched
//   mineEdited    did this window change anything at all since its base
//   theirsMoved   did the disk copy move since this window's base
//   bodyHunks     notes regions both changed differently — the merged body
//                 holds this window's text there, the disk's is in `remote`
//   otherConflicts  structured leaves both changed differently (mine kept)
//   bodyDeclined  the notes merge declined (too large to reason about) — mine
//                 is kept and `theirsNotes` is what the caller should keep a
//                 copy of
// }
export function mergeOpenDeckSnapshots(base, mine, theirs) {
  const b = snapshotContent(base);
  const m = snapshotContent(mine);
  const t = snapshotContent(theirs);
  const mineEdited = !sameValue(m, b);
  const theirsMoved = !sameValue(t, b);

  // Notes: the reader's prose and the fenced highlight-note block below it are
  // merged separately, so a highlight note landing never reads as prose moving.
  const bn = splitHighlightNotesTail(b.notes);
  const mn = splitHighlightNotesTail(m.notes);
  const tn = splitHighlightNotesTail(t.notes);
  const body = mergeText(bn.body, mn.body, tn.body);
  const tail = mergeText(bn.tail, mn.tail, tn.tail);
  const notes = joinHighlightNotesTail(body.merged, tail.ok ? tail.merged : mn.tail || tn.tail);

  const { notes: _n, ...bRest } = b;
  const { notes: _m, ...mRest } = m;
  const { notes: _t, ...tRest } = t;
  const rest = mergeValues(bRest, mRest, tRest);

  // Cards carry their sync bookkeeping from whichever stored copy had them —
  // the caller restamps dirty/updatedAt against the disk copy afterwards.
  const storedById = new Map((Array.isArray(theirs?.cards) ? theirs.cards : []).map((c) => [String(c.id), c]));
  const cards = (rest.value.cards || []).map((card) => {
    const stored = storedById.get(String(card.id));
    if (!stored) return card;
    const extra = {};
    if (stored.syncBase) extra.syncBase = stored.syncBase;
    return { ...card, ...extra };
  });

  const snapshot = {
    ...(theirs || {}),
    ...rest.value,
    notes,
    cards
  };
  if (!snapshot.meta || typeof snapshot.meta !== "object") snapshot.meta = {};

  return {
    snapshot,
    mineEdited,
    theirsMoved,
    bodyHunks: body.ok ? body.conflicts : [],
    otherConflicts: rest.conflicts,
    bodyDeclined: !body.ok && mn.body !== tn.body,
    theirsNotes: t.notes
  };
}
