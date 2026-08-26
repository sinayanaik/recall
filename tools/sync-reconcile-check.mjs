// Does a deck's CARDS survive two devices — and does a deletion stay deleted?
//
//   node tools/sync-reconcile-check.mjs
//
// tools/document-sync-check.mjs asks this of a paper's annotations. This asks it
// of everything else: the per-card merge, the tombstones that make a deletion
// stick, the timestamps that choose the direction, and the resolver that answers
// a notes conflict.
//
// ── Why this exists ────────────────────────────────────────────────────────
//
// The two harnesses that covered this half — tools/sync-parity.mjs and
// tools/reconcile-parity.mjs — both begin:
//
//     if (!puppeteer || !CHROME) { …"skipping."; process.exit(0); }
//
// and both then need `git archive pre-modular`, a tag not every clone carries.
// On a machine with neither they report success having verified nothing, which
// is the failure mode tools/cdp.mjs's own header warns about: "a check that
// skips is a check that never catches anything". Nothing in CI runs them either
// — .github/workflows/deploy.yml only stamps and publishes.
//
// So the card/tombstone/timestamp logic, which is where every bug this file was
// written for actually lived, had no executable test at all.
//
// This one needs no browser, no baseline tag and no network, for the same reason
// document-sync-check does not: the merge is pure string-and-object work by
// design. It drives the REAL modules — src/sync/cards.js, src/sync/document-sync.js,
// src/sync/notes-conflict-merge.js, src/sync/stats.js — in the order
// reconcileAllDecks calls them, so a case that passes here is a case the app
// passes.
//
// The one accommodation, copied from document-sync-check: every import in src/
// carries `?v=__BUILD__`, a cache-busting query the static server understands.
// The tree is staged to a temp directory with the stamp removed, exactly as the
// deploy step rewrites it.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-syncrec-"));

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
function must(name, fn) {
  let detail;
  try {
    detail = fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  // ── The smallest possible browser ────────────────────────────────────────
  //
  // Same stubs, and the same reasoning, as document-sync-check.mjs: the modules
  // under test touch none of this, but their IMPORTS evaluate src/core/dom.js at
  // module scope. Every stub returns the empty answer and nothing here asserts
  // on one — a stub that were actually exercised would be a check testing its
  // own scaffolding.
  const noElement = new Proxy({}, {
    get: (_, key) => (key === "querySelector" || key === "querySelectorAll" || key === "closest" ? () => null : undefined)
  });
  globalThis.document = {
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => noElement, addEventListener: () => {}, documentElement: noElement, body: noElement
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; }
  };
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};

  // The blank-read cases below deliberately drive the paths that warn ("Cloud
  // returned 0 cards…"), and several do it hundreds of times inside the property
  // loop. Those warnings are the code working, not a problem to report, and left
  // on stderr they drown the summary this check is read by. Collected instead, so
  // a case can still assert one fired if it ever needs to.
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));

  const load = (rel) => import(path.join(stage, rel));

  const cards = await load("src/sync/cards.js");
  const docSync = await load("src/sync/document-sync.js");
  const fence = await load("src/format/notes-fence.js");
  const stats = await load("src/sync/stats.js");
  const diff = await load("src/sync/diff.js");
  const conflict = await load("src/sync/notes-conflict-merge.js");

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const iso = (ms) => new Date(ms).toISOString();

  // A base time far enough in the past to be stable, but well inside the
  // 180-day tombstone horizon (CARD_TOMBSTONE_MAX_AGE_MS) — a fixture dated
  // outside it retires on age alone and every assertion below would pass for
  // the wrong reason.
  const T0 = Date.now() - 60 * 60 * 1000;
  const MIN = 60_000;

  // ── The world ────────────────────────────────────────────────────────────
  //
  // One cloud {deck, cards}, and devices each holding a snapshot plus the index
  // entry the reconcile actually decides on. The functions below call exactly
  // what src/sync/reconcile.js calls, in the same order.
  const makeCloud = (id = "d1") => ({
    deck: { id, title: "Deck", category: "C", notes: "", meta: {}, updated_at: iso(T0) },
    cards: []
  });

  const makeDevice = (name, { clockOffsetMs = 0 } = {}) => ({
    name,
    clockOffsetMs,
    snapshot: { deckTitle: "Deck", notes: "", meta: {}, cards: [] },
    entry: { deckId: "d1", updatedAt: iso(T0), lastSyncedAt: iso(T0) },
    stash: null,
    conflicted: false
  });

  // Each device reads its own clock. That is the whole point of the skew cases:
  // nothing in the app ever asks a server what time it is.
  const nowOn = (dev, wallMs) => iso(wallMs + dev.clockOffsetMs);

  // A local edit, as saveDeckToLibrary → finishSaveDeckToLibrary performs it:
  // stamp the per-card sync state against the copy being replaced, record any
  // deletion as a tombstone, then advance the index entry's updatedAt.
  function editLocally(dev, wallMs, mutate) {
    const previous = clone(dev.snapshot);
    mutate(dev.snapshot);
    const stampIso = nowOn(dev, wallMs);
    cards.stampCardSyncState(dev.snapshot, previous, stampIso);
    cards.recordDeletedCardIds(dev.snapshot, previous, stampIso);
    dev.entry.updatedAt = stats.nextSyncStamp(stampIso, dev.entry.updatedAt);
  }

  const addCard = (dev, wallMs, id, text) =>
    editLocally(dev, wallMs, (s) => { s.cards.push({ id, question: text, answer: "a" }); });
  const changeCard = (dev, wallMs, id, text) =>
    editLocally(dev, wallMs, (s) => { s.cards.find((c) => c.id === id).question = text; });
  const deleteCard = (dev, wallMs, id) =>
    editLocally(dev, wallMs, (s) => { s.cards = s.cards.filter((c) => c.id !== id); });
  const editNotes = (dev, wallMs, body) =>
    editLocally(dev, wallMs, (s) => { s.notes = fence.joinHighlightNotesTail(body, fence.splitHighlightNotesTail(s.notes).tail); });

  // Which way this deck would sync, by the two gates in reconcileAllDecks.
  function direction(dev, cloud) {
    if (stats.tsMs(cloud.deck.updated_at) > stats.tsMs(dev.entry.updatedAt)) return "pull";
    if (stats.tsMs(dev.entry.updatedAt) > stats.tsMs(cloud.deck.updated_at)) return "push";
    return "none";
  }

  // pullCloudDeckIntoLibraryLocked, minus the storage plumbing.
  function pull(dev, cloud, wallMs, { cardRows = null } = {}) {
    const rows = cardRows === null ? clone(cloud.cards) : cardRows;
    const cloudIso = cloud.deck.updated_at;
    const merged = cards.mergeCloudCardsIntoSnapshot(dev.snapshot, rows, cloudIso);

    const incomingMeta = docSync.mergeDeckMeta(cloud.deck.meta, dev.snapshot.meta, { prefer: "cloud" });
    const documentMerge = docSync.mergeDocumentAnnotations({
      cloudNotes: cloud.deck.notes,
      cloudMeta: cloud.deck.meta,
      localNotes: dev.snapshot.notes,
      localMeta: dev.snapshot.meta,
      body: "cloud",
      extraTails: dev.stash ? [fence.splitHighlightNotesTail(dev.stash).tail] : []
    });
    if (documentMerge.pdfHighlights) incomingMeta.pdfHighlights = documentMerge.pdfHighlights;

    const oldBody = fence.splitHighlightNotesTail(dev.snapshot.notes).body;
    const newBody = fence.splitHighlightNotesTail(documentMerge.notes).body;
    // The conflict question, asked exactly as reconcile.js asks it — including
    // the skew clause, which is what stops a cloud row stamped in this device's
    // future from replacing a local edit with no copy kept.
    if (diff.syncTextChanged(oldBody, newBody) && oldBody.trim()) {
      const localNotesEdited = stats.tsMs(dev.entry.updatedAt) > stats.tsMs(dev.entry.lastSyncedAt);
      const unorderable = stats.clockSkewedAhead(cloudIso, nowOn(dev, wallMs));
      const notesBeingEmptied = oldBody.trim() && !newBody.trim();
      if (localNotesEdited || notesBeingEmptied || unorderable) {
        dev.conflicted = true;
        dev.stash = dev.snapshot.notes;
      }
    } else if (dev.stash && !diff.syncTextChanged(fence.splitHighlightNotesTail(dev.stash).body, newBody)) {
      dev.stash = null;
      dev.conflicted = false;
    }

    dev.snapshot.cards = merged.cards;
    dev.snapshot.notes = documentMerge.notes;
    dev.snapshot.meta = incomingMeta;
    if (Object.keys(merged.deletedCardIds).length) dev.snapshot.deletedCardIds = merged.deletedCardIds;
    else delete dev.snapshot.deletedCardIds;

    // A merge that kept local cards (or blocked a resurrection) still owes the
    // cloud a push, so it must NOT read as aligned.
    dev.entry.updatedAt = (merged.keptLocal || merged.blockedResurrections)
      ? stats.nextSyncStamp(nowOn(dev, wallMs), cloudIso)
      : cloudIso;
    dev.entry.lastSyncedAt = cloudIso;
    return merged;
  }

  // pushLibraryDeckToCloud, minus the network.
  function push(dev, cloud, wallMs) {
    const reconciled = cards.reconcileCardsBeforePush(dev.snapshot, clone(cloud.cards));
    dev.snapshot.cards = reconciled.cards;
    const tombstonesBeingPruned = Object.keys(reconciled.deletedCardIds);
    if (tombstonesBeingPruned.length) dev.snapshot.deletedCardIds = reconciled.deletedCardIds;
    else delete dev.snapshot.deletedCardIds;

    const documentPush = docSync.reconcileDeckBeforePush(dev.snapshot, cloud.deck);
    if (!documentPush) throw new Error("refused to push against a row with no notes column");

    const cloudBody = fence.splitHighlightNotesTail(String(cloud.deck.notes || "")).body;
    const pushedBody = fence.splitHighlightNotesTail(String(documentPush.notes || "")).body;
    const cloudMoved = stats.tsMs(cloud.deck.updated_at) > stats.tsMs(dev.entry.lastSyncedAt);
    const unorderable = stats.clockSkewedAhead(cloud.deck.updated_at, nowOn(dev, wallMs));
    if (cloudBody.trim() && (cloudMoved || unorderable) && diff.syncTextChanged(cloudBody, pushedBody)) {
      dev.stash = String(cloud.deck.notes || "");
      dev.conflicted = true;
    }
    dev.snapshot.notes = documentPush.notes;
    dev.snapshot.meta = documentPush.meta;

    // Monotonic: never stamp the row backwards past the copy this push merged
    // against, or the other device's clock decides whose work survives.
    const now = stats.nextSyncStamp(nowOn(dev, wallMs), cloud.deck.updated_at);

    // The cloud is authoritative after a push: every row missing from what we
    // send is pruned (pushDeckRowsToCloud), which is only safe because the
    // reconcile above made the list a superset.
    const sent = dev.snapshot.cards.map((c) => ({
      id: c.id, deck_id: cloud.deck.id, question: c.question, answer: c.answer,
      status: c.status ?? null, category: c.category ?? null, updated_at: now
    }));
    const sentIds = new Set(sent.map((r) => String(r.id)));
    const kept = cloud.cards.filter((r) => sentIds.has(String(r.id)));
    const keptById = new Map(kept.map((r) => [String(r.id), r]));
    cloud.cards = sent.map((row) => {
      const existing = keptById.get(String(row.id));
      // Unchanged rows are filtered out of the upsert, so they keep the stamp
      // they already had — restamping them all would hide an ordering bug.
      if (existing && existing.question === row.question && existing.answer === row.answer) return existing;
      return row;
    });
    cloud.deck.notes = dev.snapshot.notes;
    cloud.deck.meta = clone(dev.snapshot.meta);
    cloud.deck.updated_at = now;

    // The cloud now holds exactly what we sent, so every card still matching it
    // is confirmed clean — the same rule pushLibraryDeckToCloud applies against
    // its re-read snapshot. Leaving them dirty would make the pull's
    // "clean and absent from the cloud means deleted elsewhere" rule unreachable.
    const sentSignature = new Map(sent.map((r) => [String(r.id), cards.cardSyncSignature(r)]));
    for (const card of dev.snapshot.cards) {
      if (sentSignature.get(String(card.id)) === cards.cardSyncSignature(card)) card.dirty = false;
    }

    for (const id of tombstonesBeingPruned) delete dev.snapshot.deletedCardIds?.[id];
    if (dev.snapshot.deletedCardIds && !Object.keys(dev.snapshot.deletedCardIds).length) delete dev.snapshot.deletedCardIds;
    for (const id of documentPush.tombstonesBeingPruned || []) delete dev.snapshot.meta.deletedHighlightIds?.[id];

    dev.entry.updatedAt = now;
    dev.entry.lastSyncedAt = now;
    return reconciled;
  }

  // One device's whole reconcile pass: whichever way the gates point.
  function sync(dev, cloud, wallMs, options = {}) {
    const way = direction(dev, cloud);
    if (way === "pull") return { way, result: pull(dev, cloud, wallMs, options) };
    if (way === "push") return { way, result: push(dev, cloud, wallMs) };
    return { way, result: null };
  }

  const cardIds = (dev) => dev.snapshot.cards.map((c) => c.id).sort().join(",");
  const cloudIds = (cloud) => cloud.cards.map((c) => c.id).sort().join(",");
  const questionOf = (dev, id) => dev.snapshot.cards.find((c) => c.id === id)?.question ?? null;
  const tombstonesOf = (dev) => Object.keys(cards.readCardTombstones(dev.snapshot)).sort().join(",");

  // ══ F1. A cloud read we would not delete on is not one we may retire a
  //        tombstone on ═════════════════════════════════════════════════════
  //
  // Both merge paths already refuse to drop a local card when the cloud's card
  // list comes back empty (`cloudLooksBlank`). They used to retire every
  // tombstone on that same read anyway — so the deletion's only evidence was
  // destroyed by the very read that was declared untrustworthy, and the next
  // healthy sync adopted the card back and re-pushed it to every device.
  {
    const snapshot = {
      cards: [{ id: "c1", question: "q1", answer: "a1", dirty: false, updatedAt: iso(T0) }],
      deletedCardIds: { c2: iso(T0 + MIN) }
    };
    const blankPull = cards.mergeCloudCardsIntoSnapshot(snapshot, [], iso(T0 + 2 * MIN));
    must("a blank cloud card read does not retire the pull's tombstones", () =>
      Object.keys(blankPull.deletedCardIds).join(",") === "c2"
      || `tombstones became ${JSON.stringify(blankPull.deletedCardIds)}`);

    const blankPush = cards.reconcileCardsBeforePush(snapshot, []);
    must("...nor the push's", () =>
      Object.keys(blankPush.deletedCardIds).join(",") === "c2"
      || `tombstones became ${JSON.stringify(blankPush.deletedCardIds)}`);

    must("...and the blank read still keeps every local card", () =>
      (blankPull.cards.map((c) => c.id).join(",") === "c1" && blankPush.cards.map((c) => c.id).join(",") === "c1")
      || `pull kept ${blankPull.cards.length}, push sent ${blankPush.cards.length}`);

    // The other half of the rule: a read that DID come back is trusted, so a
    // tombstone whose card the cloud no longer has is spent and must retire —
    // or a card the user later re-creates with the same id could never sync.
    const healthy = cards.mergeCloudCardsIntoSnapshot(snapshot, [
      { id: "c1", question: "q1", answer: "a1", updated_at: iso(T0) }
    ], iso(T0 + 2 * MIN));
    must("...while a healthy read that lacks the card still retires it", () =>
      Object.keys(healthy.deletedCardIds).length === 0
      || `tombstones stayed ${JSON.stringify(healthy.deletedCardIds)}`);

    const stillThere = cards.mergeCloudCardsIntoSnapshot(snapshot, [
      { id: "c1", question: "q1", answer: "a1", updated_at: iso(T0) },
      { id: "c2", question: "q2", answer: "a2", updated_at: iso(T0) }
    ], iso(T0 + 2 * MIN));
    must("...and one the cloud still holds is kept, and blocks the resurrection", () =>
      (Object.keys(stillThere.deletedCardIds).join(",") === "c2"
        && stillThere.blockedResurrections === 1
        && !stillThere.cards.some((c) => c.id === "c2"))
      || `tombstones ${JSON.stringify(stillThere.deletedCardIds)}, blocked ${stillThere.blockedResurrections}`);
  }

  // The end-to-end consequence: a deletion made on A, with B's card read coming
  // back blank in between, must not come back.
  {
    const cloud = makeCloud();
    const a = makeDevice("A");
    const b = makeDevice("B");
    addCard(a, T0 + MIN, "c1", "one");
    addCard(a, T0 + MIN, "c2", "two");
    push(a, cloud, T0 + 2 * MIN);
    pull(b, cloud, T0 + 3 * MIN);

    deleteCard(a, T0 + 3 * MIN, "c2");
    // A's sync happens while the cards read for this deck comes back empty.
    sync(a, cloud, T0 + 4 * MIN, { cardRows: [] });
    // ...and then everything is healthy again, for as many rounds as it takes.
    for (let round = 0; round < 3; round += 1) {
      sync(a, cloud, T0 + (5 + round * 2) * MIN);
      sync(b, cloud, T0 + (6 + round * 2) * MIN);
    }

    must("a deletion survives a blank read on the deleting device", () =>
      cardIds(a) === "c1" || `A holds ${cardIds(a)}`);
    must("...and does not come back on the other device", () =>
      cardIds(b) === "c1" || `B holds ${cardIds(b)}`);
    must("...nor in the cloud", () =>
      cloudIds(cloud) === "c1" || `cloud holds ${cloudIds(cloud)}`);
  }

  // ══ F2. The notes-conflict resolver must not eat the highlight-notes block ══
  //
  // A stash holds the WHOLE notes string, fenced block included — deliberately,
  // because the pull mines its tail to recover stranded annotations. Both
  // resolvers treated it as plain prose, and highlightNotesBlockSpan takes the
  // LAST opening marker: so "Keep both" let the stash's older tail win, demoted
  // the merged one into the body, and left a raw fence rendering as prose. The
  // button says "Nothing is lost".
  {
    const OPEN = "<!--recall:highlight-notes-->";
    const tail = (line) => `${OPEN}\n${line}\n<!--/recall:highlight-notes-->`;
    const current = fence.joinHighlightNotesTail("Cloud prose.", tail("- h1: merged note"));
    const stash = fence.joinHighlightNotesTail("My prose.", tail("- h1: my older note"));

    const both = conflict.mergeRestoredNotes(current, stash, "an earlier sync");
    const bothSplit = fence.splitHighlightNotesTail(both);
    must("\"Keep both\" keeps the merged highlight note", () =>
      bothSplit.tail.includes("merged note") || `tail was ${JSON.stringify(bothSplit.tail)}`);
    must("...and leaves no fence marker stranded in the body", () =>
      !bothSplit.body.includes(OPEN) || `body was ${JSON.stringify(bothSplit.body)}`);
    must("...while still bringing back the reader's own prose", () =>
      (bothSplit.body.includes("Cloud prose.") && bothSplit.body.includes("My prose."))
      || `body was ${JSON.stringify(bothSplit.body)}`);

    const mine = conflict.promoteStashedNotes(current, stash);
    const mineSplit = fence.splitHighlightNotesTail(mine);
    must("\"Keep mine\" takes the stash's prose", () =>
      mineSplit.body.trim() === "My prose." || `body was ${JSON.stringify(mineSplit.body)}`);
    must("...and keeps the merged highlight note rather than the stash's stale one", () =>
      (mineSplit.tail.includes("merged note") && !mineSplit.tail.includes("my older note"))
      || `tail was ${JSON.stringify(mineSplit.tail)}`);

    // A deck that never had annotations must come through both resolvers
    // unchanged in shape — no fence invented, no trailing rule accumulated.
    const plainBoth = conflict.mergeRestoredNotes("New text.", "Old text.", "then");
    must("a deck with no annotations grows no fence", () =>
      (!plainBoth.includes(OPEN) && plainBoth.includes("New text.") && plainBoth.includes("Old text."))
      || `got ${JSON.stringify(plainBoth)}`);
    must("...and \"Keep mine\" on one is just the stash", () =>
      conflict.promoteStashedNotes("New text.", "Old text.").trim() === "Old text."
      || `got ${JSON.stringify(conflict.promoteStashedNotes("New text.", "Old text."))}`);
  }

  // ══ F3. Two devices, two clocks ═══════════════════════════════════════════
  //
  // Every timestamp that chooses a sync direction is written by the CLIENT —
  // deliberately, since the push's epoch sentinel and the per-card merge both
  // depend on exact values (supabase_setup.sql section 5). Nothing compensated
  // for two devices disagreeing about the time, and the safety nets are all
  // timestamp comparisons, so they failed silently in the same direction.
  {
    const cloud = makeCloud();
    const fast = makeDevice("Fast", { clockOffsetMs: 2 * 60 * 60 * 1000 }); // 2h ahead
    const slow = makeDevice("Slow");

    addCard(fast, T0 + MIN, "c1", "from the fast device");
    editNotes(fast, T0 + MIN, "written on the fast device");
    push(fast, cloud, T0 + 2 * MIN);
    pull(slow, cloud, T0 + 3 * MIN);

    // The slow device edits AFTER the fast one, by the wall clock, and its stamp
    // is nonetheless two hours behind the row it is editing.
    editNotes(slow, T0 + 10 * MIN, "written on the slow device");
    changeCard(slow, T0 + 10 * MIN, "c1", "changed on the slow device");

    must("an edit on the slower clock still outranks the deck's own baseline", () =>
      stats.tsMs(slow.entry.updatedAt) > stats.tsMs(cloud.deck.updated_at)
      || `local ${slow.entry.updatedAt} vs cloud ${cloud.deck.updated_at}`);

    const went = sync(slow, cloud, T0 + 11 * MIN);
    must("...so the slow device pushes rather than pulling over its own work", () =>
      went.way === "push" || `it chose to ${went.way}`);
    must("...and its notes reach the cloud", () =>
      fence.splitHighlightNotesTail(cloud.deck.notes).body.includes("slow device")
      || `cloud body is ${JSON.stringify(fence.splitHighlightNotesTail(cloud.deck.notes).body)}`);
    must("...along with its card edit", () =>
      cloud.cards.find((c) => c.id === "c1")?.question === "changed on the slow device"
      || `cloud card is ${JSON.stringify(cloud.cards.find((c) => c.id === "c1")?.question)}`);

    // ...and the fast device picks it up rather than stamping over it.
    sync(fast, cloud, T0 + 12 * MIN);
    must("...and the fast device adopts it instead of overwriting it", () =>
      questionOf(fast, "c1") === "changed on the slow device"
      || `fast holds ${JSON.stringify(questionOf(fast, "c1"))}`);
  }

  // When the two clocks genuinely cannot order two edits, the losing copy is
  // kept rather than silently dropped.
  {
    const cloud = makeCloud();
    const fast = makeDevice("Fast", { clockOffsetMs: 2 * 60 * 60 * 1000 });
    const slow = makeDevice("Slow");
    editNotes(fast, T0 + MIN, "the fast device's writing");
    push(fast, cloud, T0 + 2 * MIN);

    // The slow device has its own body and has never seen the cloud's. The row
    // is stamped in its future, so no comparison here means anything.
    slow.snapshot.notes = "the slow device's writing";
    slow.entry.updatedAt = iso(T0 + 3 * MIN);
    slow.entry.lastSyncedAt = iso(T0);
    pull(slow, cloud, T0 + 3 * MIN);
    must("a body replaced under unorderable clocks is stashed, not dropped", () =>
      (slow.conflicted && String(slow.stash || "").includes("slow device's writing"))
      || `conflicted=${slow.conflicted} stash=${JSON.stringify(slow.stash)}`);

    must("...and the skew itself is detectable, so it can be reported", () =>
      stats.clockSkewedAhead(cloud.deck.updated_at, iso(T0 + 3 * MIN))
      || `skew not detected for ${cloud.deck.updated_at}`);
    must("...while an ordinary in-sync pair reads as no skew at all", () =>
      !stats.clockSkewedAhead(iso(T0), iso(T0 + MIN))
      || "a normal timestamp was reported as skewed");
  }

  // ══ Convergence ═══════════════════════════════════════════════════════════
  //
  // The generic property, and the one that catches classes rather than
  // instances: whatever the two devices did, a second round must change nothing
  // anywhere. A merge that keeps flip-flopping passes every individual
  // assertion above and still never settles.
  {
    const cloud = makeCloud();
    const a = makeDevice("A");
    const b = makeDevice("B");
    addCard(a, T0 + MIN, "c1", "one");
    addCard(a, T0 + MIN, "c2", "two");
    push(a, cloud, T0 + 2 * MIN);
    pull(b, cloud, T0 + 3 * MIN);

    changeCard(a, T0 + 3 * MIN, "c1", "one, edited on A");
    addCard(b, T0 + 4 * MIN, "c3", "three, added on B");
    deleteCard(b, T0 + 5 * MIN, "c2");

    for (let round = 0; round < 4; round += 1) {
      sync(a, cloud, T0 + (6 + round * 2) * MIN);
      sync(b, cloud, T0 + (7 + round * 2) * MIN);
    }

    must("two devices editing one deck converge on the same cards", () =>
      (cardIds(a) === cardIds(b) && cardIds(a) === cloudIds(cloud))
      || `A=${cardIds(a)} B=${cardIds(b)} cloud=${cloudIds(cloud)}`);
    must("...keeping the edit made on A", () =>
      questionOf(a, "c1") === "one, edited on A" && questionOf(b, "c1") === "one, edited on A"
      || `A=${questionOf(a, "c1")} B=${questionOf(b, "c1")}`);
    must("...and the card added on B", () =>
      questionOf(a, "c3") === "three, added on B" || `A holds ${cardIds(a)}`);
    must("...and honouring the deletion made on B", () =>
      !cardIds(a).split(",").includes("c2") || `A still holds ${cardIds(a)}`);

    const before = JSON.stringify([cardIds(a), cardIds(b), cloudIds(cloud), cloud.deck.notes]);
    sync(a, cloud, T0 + 20 * MIN);
    sync(b, cloud, T0 + 21 * MIN);
    must("...and a further round changes nothing at all", () =>
      JSON.stringify([cardIds(a), cardIds(b), cloudIds(cloud), cloud.deck.notes]) === before
      || "a settled library still moved on the next sync");
  }

  // ══ Edit beats delete, deliberately ═══════════════════════════════════════
  //
  // A card deleted on one device while the other was editing it — without having
  // pushed that edit — comes BACK rather than staying deleted. That is the
  // "local only, dirty → keep" arm of mergeCloudCardsIntoSnapshot, and it is the
  // right way round: a card that reappears can be deleted again, an edit that
  // was never anywhere else cannot be recovered. Pinned here because it is a
  // real contract and not an accident, and because the property loop below has
  // to know it is not a resurrection bug.
  {
    const cloud = makeCloud();
    const a = makeDevice("A");
    const b = makeDevice("B");
    addCard(a, T0 + MIN, "c1", "one");
    addCard(a, T0 + MIN, "c2", "two");
    push(a, cloud, T0 + 2 * MIN);
    pull(b, cloud, T0 + 3 * MIN);

    changeCard(a, T0 + 4 * MIN, "c2", "two, edited on A and never pushed");
    deleteCard(b, T0 + 5 * MIN, "c2");
    sync(b, cloud, T0 + 6 * MIN);   // B's deletion reaches the cloud first

    for (let round = 0; round < 3; round += 1) {
      sync(a, cloud, T0 + (7 + round * 2) * MIN);
      sync(b, cloud, T0 + (8 + round * 2) * MIN);
    }

    must("an unpushed edit is not destroyed by a delete on the other device", () =>
      questionOf(a, "c2") === "two, edited on A and never pushed"
      || `A holds ${JSON.stringify(questionOf(a, "c2"))}`);
    must("...the card comes back rather than the edit being lost", () =>
      cardIds(a) === "c1,c2" && cardIds(b) === "c1,c2" && cloudIds(cloud) === "c1,c2"
      || `A=${cardIds(a)} B=${cardIds(b)} cloud=${cloudIds(cloud)}`);
    must("...and both devices agree on the text that survived", () =>
      questionOf(b, "c2") === questionOf(a, "c2")
      || `A=${JSON.stringify(questionOf(a, "c2"))} B=${JSON.stringify(questionOf(b, "c2"))}`);

    // ...whereas a deletion with no edit racing it stays deleted, which is the
    // case the tombstones exist for and the one the loop below asserts.
    deleteCard(b, T0 + 20 * MIN, "c1");
    for (let round = 0; round < 3; round += 1) {
      sync(b, cloud, T0 + (21 + round * 2) * MIN);
      sync(a, cloud, T0 + (22 + round * 2) * MIN);
    }
    must("...while an uncontested deletion still sticks", () =>
      cardIds(a) === "c2" && cardIds(b) === "c2" && cloudIds(cloud) === "c2"
      || `A=${cardIds(a)} B=${cardIds(b)} cloud=${cloudIds(cloud)}`);
  }

  // ══ Emptying a deck's last cards does not stick — a known limitation ══════
  //
  // This one is PINNED, not asserted as correct. mergeCloudCardsIntoSnapshot
  // refuses to read a zero-row card list as "everything was deleted elsewhere"
  // (`cloudLooksBlank`), because that is also what a bad read looks like and the
  // cost of believing it wrongly is the whole deck. Its comment says a deck
  // genuinely emptied elsewhere "still converges: that device holds per-card
  // tombstones and re-deletes these rows".
  //
  // It does not. The tombstone is retired by the very push that emptied the
  // cloud — the id was in the cloud when the push diffed against it, so it lands
  // in tombstonesBeingPruned and is dropped once the write succeeds. So the
  // deleting device has no tombstone left, the other device refuses the blank
  // read and pushes its copies back, and the deletion is undone everywhere.
  //
  // Retaining the tombstone does not fix it either: the other device's refusal
  // is unconditional, so the two just alternate pruning and re-pushing forever.
  // The real answer is a design decision (believe a count-verified empty read,
  // or hold the cards without pushing them, as heldDeckIds does at deck level)
  // and is deliberately NOT made here. This case exists so the behaviour is
  // visible and cannot change by accident.
  {
    const cloud = makeCloud();
    const a = makeDevice("A");
    const b = makeDevice("B");
    addCard(a, T0 + MIN, "c1", "the only card");
    push(a, cloud, T0 + 2 * MIN);
    pull(b, cloud, T0 + 3 * MIN);

    deleteCard(a, T0 + 4 * MIN, "c1");
    sync(a, cloud, T0 + 5 * MIN);
    must("emptying a deck does reach the cloud", () =>
      cloudIds(cloud) === "" || `cloud still holds ${cloudIds(cloud)}`);
    must("...and the deleting device retains no tombstone afterwards", () =>
      tombstonesOf(a) === "" || `A still holds tombstones ${tombstonesOf(a)}`);

    sync(b, cloud, T0 + 6 * MIN);   // B refuses the blank read and keeps its copy
    sync(b, cloud, T0 + 7 * MIN);   // ...then pushes it back
    must("KNOWN LIMITATION: the other device pushes the emptied cards back", () =>
      cloudIds(cloud) === "c1" || `cloud holds ${cloudIds(cloud)} — the limitation may have been fixed; update this case`);

    sync(a, cloud, T0 + 8 * MIN);
    must("...and nothing is LOST by it — the card is on both devices", () =>
      (cardIds(a) === "c1" && cardIds(b) === "c1")
      || `A=${cardIds(a)} B=${cardIds(b)}`);
  }

  // ══ The property loop ═════════════════════════════════════════════════════
  //
  // Randomised sequences of edits, additions and deletions across two devices,
  // asserting the invariant this whole subsystem exists for. Seeded, so a
  // failure names a run that can be replayed rather than one nobody can find
  // again.
  {
    // One seed replays one run, with a step trace:
    //   SYNC_CHECK_SEED=3133719261 node tools/sync-reconcile-check.mjs
    // The reported seed is the one the run STARTED from, not the generator's
    // state when the assertion failed — those differ by twelve steps, and
    // reporting the latter names a run nobody can reach.
    const replaySeed = Number(process.env.SYNC_CHECK_SEED || "") || null;
    const trace = replaySeed ? (line) => console.log(`    · ${line}`) : () => {};
    const ROUNDS = replaySeed ? 1 : 300;
    let seed = replaySeed || 20260826;
    const rnd = () => {
      // xorshift32 — a real generator rather than Math.random, so a failing seed
      // reproduces exactly.
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 0x100000000;
    };
    const pick = (list) => list[Math.floor(rnd() * list.length)];

    let broken = null;
    for (let run = 0; run < ROUNDS && !broken; run += 1) {
      const runSeed = seed;
      const cloud = makeCloud();
      const a = makeDevice("A");
      const b = makeDevice("B");
      let wall = T0 + MIN;
      let nextId = 0;
      // Everything either device has ever deliberately deleted, and everything
      // it has committed. The invariant is stated over these two sets.
      const deleted = new Set();
      const committed = new Map();
      // Ids where a deletion raced an edit the other device had not pushed. The
      // app resolves those as edit-wins (see the case above), so they are not
      // resurrections and the invariant below must not treat them as such.
      const contested = new Set();
      const other = (dev) => (dev === a ? b : a);
      // A push that leaves the deck with no cloud cards at all puts every
      // outstanding deletion into the known limitation above: the other device
      // refuses the blank read and pushes its copies back, and no tombstone
      // survives to stop it. Contested, not a fresh bug — so both the step loop
      // and the settle rounds have to notice it.
      const noteBlankCloud = (dev) => {
        if (cloud.cards.length || !other(dev).snapshot.cards.length) return;
        for (const id of deleted) contested.add(String(id));
      };
      const dirtyElsewhere = (dev, id) =>
        Boolean(other(dev).snapshot.cards.find((c) => String(c.id) === String(id) && c.dirty));

      addCard(a, wall, "seed", "seed card");
      committed.set("seed", "seed card");
      push(a, cloud, (wall += MIN));
      pull(b, cloud, T0 + 3 * MIN);

      for (let step = 0; step < 12; step += 1) {
        const dev = pick([a, b]);
        const action = pick(["add", "edit", "delete", "sync", "sync", "notes"]);
        wall += MIN;
        trace(`${dev.name} ${action} (A=${cardIds(a) || "-"} B=${cardIds(b) || "-"} cloud=${cloudIds(cloud) || "-"})`);
        if (action === "add") {
          const id = `c${nextId++}`;
          const text = `${id} by ${dev.name}`;
          addCard(dev, wall, id, text);
          committed.set(id, text);
          deleted.delete(id);
        } else if (action === "edit" && dev.snapshot.cards.length) {
          const card = pick(dev.snapshot.cards);
          const text = `${card.id} edited by ${dev.name} at ${wall}`;
          changeCard(dev, wall, card.id, text);
          committed.set(card.id, text);
          // Editing something the other device has already deleted is the same
          // contest seen from the other side.
          if (deleted.has(String(card.id))) contested.add(String(card.id));
        } else if (action === "delete" && dev.snapshot.cards.length > 1) {
          const card = pick(dev.snapshot.cards);
          if (dirtyElsewhere(dev, card.id)) contested.add(String(card.id));
          deleteCard(dev, wall, card.id);
          deleted.add(card.id);
          committed.delete(card.id);
        } else if (action === "notes") {
          editNotes(dev, wall, `notes by ${dev.name} at ${wall}`);
        } else {
          const went = sync(dev, cloud, wall);
          trace(`   ${dev.name} ${went.way}`);
        }
        noteBlankCloud(dev);
      }
      // Settle: enough alternating rounds for anything outstanding to propagate
      // both ways.
      for (let round = 0; round < 6; round += 1) {
        const wa = sync(a, cloud, (wall += MIN));
        noteBlankCloud(a);
        const wb = sync(b, cloud, (wall += MIN));
        noteBlankCloud(b);
        trace(`settle ${round}: A ${wa.way}, B ${wb.way} — A=${cardIds(a) || "-"} B=${cardIds(b) || "-"} cloud=${cloudIds(cloud) || "-"}`);
      }
      trace(`deleted=${[...deleted].join(",") || "-"} committed=${[...committed.keys()].join(",") || "-"} contested=${[...contested].join(",") || "-"}`);
      trace(`A tombstones=${tombstonesOf(a) || "-"} B tombstones=${tombstonesOf(b) || "-"}`);

      const onA = new Set(a.snapshot.cards.map((c) => c.id));
      const onB = new Set(b.snapshot.cards.map((c) => c.id));
      const inCloud = new Set(cloud.cards.map((c) => String(c.id)));
      for (const id of deleted) {
        if (contested.has(String(id))) continue;
        if (onA.has(id) || onB.has(id) || inCloud.has(id)) {
          broken = `seed ${runSeed}: deleted card ${id} came back (A=${onA.has(id)} B=${onB.has(id)} cloud=${inCloud.has(id)})`;
          break;
        }
      }
      if (broken) break;
      for (const [id] of committed) {
        if (contested.has(String(id))) continue;
        if (!onA.has(id) || !onB.has(id) || !inCloud.has(id)) {
          broken = `seed ${runSeed}: committed card ${id} went missing (A=${onA.has(id)} B=${onB.has(id)} cloud=${inCloud.has(id)})`;
          break;
        }
      }
      if (broken) break;
      if ([...onA].sort().join(",") !== [...onB].sort().join(",")) {
        broken = `seed ${runSeed}: the two devices disagree — A=${[...onA].sort()} B=${[...onB].sort()}`;
      }
    }

    must(`${ROUNDS} randomised two-device runs lose no committed card`, () => broken === null || broken);
    must("...and resurrect no deleted one", () => broken === null || "see the line above");
  }

  console.log("── sync reconcile ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
