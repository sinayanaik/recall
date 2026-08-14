// The sync, tested twice over: does it still behave identically, and is it
// still safe?
//
//   node tools/sync-parity.mjs
//   node tools/sync-parity.mjs --base=REF
//
// Sync is the only code here that can destroy data the user cannot get back.
// It has already done so once: a read that reached Supabase without a valid
// session succeeded and matched nothing, the old code read that empty result as
// "every deck was deleted on another device", removed the local copies, and
// published tombstones that every other device then honoured. One bad read took
// the whole library everywhere.
//
// So this file asks two separate questions, and passing one is not passing the
// other:
//
//   PARITY     — the same scenario through the pre-split app.js and through the
//                modules must produce identical output. Catches anything the
//                move broke.
//
//   INVARIANTS — assertions about what the CURRENT code must never do, checked
//                on their own terms. Parity alone would happily agree that both
//                versions delete the library, because they would.
//
// Everything runs in a real browser against the real modules, so the merge sees
// the same JSON shapes it sees in production.

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = (process.argv.find((a) => a.startsWith("--base=")) || "--base=main").slice(7);

const CHROME = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"
].find(existsSync);
function loadPuppeteer() {
  for (const base of [ROOT, "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/"]) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}
const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) { console.log("sync-parity: no puppeteer/Chrome — skipping."); process.exit(0); }

// The names both sides must provide.
const API = [
  "calculateSyncDiff", "mergeCloudCardsIntoSnapshot", "reconcileCardsBeforePush",
  "stampCardSyncState", "cardIsDirty", "cardUpdatedMs", "cardSyncSignature",
  "readCardTombstones", "pruneCardTombstones", "dropTombstonesForLiveCards",
  "recordDeletedCardIds", "syncTextChanged", "sameSyncContent", "laterIsoTimestamp",
  "normalizeWebDeckPayload", "deckPayloadSnapshot", "statusByIdFromCards",
  "mergeDeckSnapshots", "backupDeckToSnapshot", "normalizeBackupDeck",
  "emptySyncStats", "totalSyncStats", "isNoOpStats", "tsMs", "normalizeCardStatus",
  "MISSING_DECK_MIN_SIGHTINGS", "MISSING_DECK_MIN_AGE_MS",
  "ADOPT_DELETION_MIN_CAP", "ADOPT_DELETION_MAX_FRACTION"
];

// Scenarios, run identically on both sides. `j` is a deterministic stringifier
// (key-sorted) so object key ORDER never shows up as a false difference.
const SCENARIOS = String.raw`(api) => {
  const OLD = "2026-01-01T00:00:00.000Z";
  const MID = "2026-06-01T00:00:00.000Z";
  const NEW = "2026-12-01T00:00:00.000Z";
  const out = {};
  // Key-sorted so object key ORDER is never a false difference, and any ISO
  // timestamp minted at call time (new Date().toISOString()) collapsed to a
  // marker — those differ between two page loads by construction, and the fact
  // that a field was stamped is what matters, not which millisecond.
  const NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const FIXED = new Set(["2026-01-01T00:00:00.000Z","2026-06-01T00:00:00.000Z","2026-12-01T00:00:00.000Z"]);
  const j = (v) => JSON.stringify(v, (k, val) => {
    if (typeof val === "string" && NOW_RE.test(val) && !FIXED.has(val)) return "<stamped-now>";
    return (val && typeof val === "object" && !Array.isArray(val))
      ? Object.fromEntries(Object.keys(val).sort().map((kk) => [kk, val[kk]]))
      : val;
  });
  const run = (label, fn) => { try { out[label] = j(fn()); } catch (e) { out[label] = "THREW: " + e.message; } };

  const card = (id, q, a, extra = {}) => ({ id, question: q, answer: a, status: null, ...extra });
  const row  = (id, q, a, updated_at, extra = {}) => ({ id, question: q, answer: a, status: null, updated_at, ...extra });

  // ── mergeCloudCardsIntoSnapshot — the card-level two-way merge ───────────
  // Tombstones live at snapshot.deletedCardIds — top level, not under meta.
  const snap = (cards, extra = {}) => ({ cards, meta: {}, ...extra });

  run("merge/empty-cloud-nonempty-local", () =>
    api.mergeCloudCardsIntoSnapshot(snap([card("a","Qa","Aa"), card("b","Qb","Ab")]), [], OLD));

  run("merge/cloud-newer-wins", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","local Q","local A",{ dirty:false, updatedAt: OLD })]),
      [row("a","cloud Q","cloud A", NEW)], OLD));

  run("merge/dirty-local-newer-wins", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","local Q","local A",{ dirty:true, updatedAt: NEW })]),
      [row("a","cloud Q","cloud A", OLD)], OLD));

  run("merge/dirty-local-older-loses", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","local Q","local A",{ dirty:true, updatedAt: OLD })]),
      [row("a","cloud Q","cloud A", NEW)], OLD));

  run("merge/clean-local-absent-from-cloud-is-dropped", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa",{ dirty:false, updatedAt: OLD }), card("b","Qb","Ab",{ dirty:false, updatedAt: OLD })]),
      [row("a","Qa","Aa", OLD)], OLD));

  run("merge/dirty-local-absent-from-cloud-survives", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa",{ dirty:false, updatedAt: OLD }), card("new","Qn","An",{ dirty:true, updatedAt: NEW })]),
      [row("a","Qa","Aa", OLD)], OLD));

  run("merge/tombstoned-card-not-resurrected", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa")], { deletedCardIds: { gone: NEW } }),
      [row("a","Qa","Aa", OLD), row("gone","Zombie","Back", OLD)], OLD));

  run("merge/noteAnchor-survives-a-pull", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa",{ dirty:false, updatedAt: OLD, noteAnchor: { offset: 12, source: "src" } })]),
      [row("a","Qa","Aa", NEW)], OLD));

  run("merge/new-cloud-card-is-adopted", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa",{ dirty:false, updatedAt: OLD })]),
      [row("a","Qa","Aa", OLD), row("b","Qb","Ab", NEW)], OLD));

  run("merge/quick-note-category-follows-cloud", () =>
    api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa",{ dirty:false, updatedAt: OLD, category: "old-cat" })]),
      [row("a","Qa","Aa", NEW, { category: "new-cat" })], OLD));

  // ── calculateSyncDiff ───────────────────────────────────────────────────
  run("diff/identical", () =>
    api.calculateSyncDiff([card("a","Q","A")], [row("a","Q","A", OLD)], {}));
  run("diff/local-edit", () =>
    api.calculateSyncDiff([card("a","Q2","A")], [row("a","Q","A", OLD)], {}));
  run("diff/local-only-card", () =>
    api.calculateSyncDiff([card("a","Q","A"), card("b","Q2","A2")], [row("a","Q","A", OLD)], {}));
  run("diff/cloud-only-card", () =>
    api.calculateSyncDiff([card("a","Q","A")], [row("a","Q","A", OLD), row("b","Q2","A2", OLD)], {}));
  run("diff/empty-cloud", () =>
    api.calculateSyncDiff([card("a","Q","A")], [], {}));
  run("diff/status-change", () =>
    api.calculateSyncDiff([card("a","Q","A")], [row("a","Q","A", OLD)], { a: "known" }));
  run("diff/reordered-ids", () =>
    api.calculateSyncDiff([card("b","Qb","Ab"), card("a","Qa","Aa")],
                          [row("a","Qa","Aa", OLD), row("b","Qb","Ab", OLD)], {}));

  // ── reconcileCardsBeforePush ────────────────────────────────────────────
  run("push/reconcile-clean", () =>
    api.reconcileCardsBeforePush(snap([card("a","Q","A",{ dirty:false, updatedAt: OLD })]),
                                 [row("a","Q","A", OLD)]));
  run("push/reconcile-cloud-newer", () =>
    api.reconcileCardsBeforePush(snap([card("a","Q","A",{ dirty:false, updatedAt: OLD })]),
                                 [row("a","CLOUD","A", NEW)]));
  run("push/reconcile-empty-cloud", () =>
    api.reconcileCardsBeforePush(snap([card("a","Q","A",{ dirty:true, updatedAt: NEW })]), []));

  // ── stamping and dirt ───────────────────────────────────────────────────
  run("stamp/marks-changed-cards-dirty", () =>
    api.stampCardSyncState(snap([card("a","Q2","A")]), snap([card("a","Q","A")]), NEW));
  run("stamp/unchanged-stays-clean", () =>
    api.stampCardSyncState(snap([card("a","Q","A",{ dirty:false, updatedAt: OLD })]),
                           snap([card("a","Q","A",{ dirty:false, updatedAt: OLD })]), NEW));
  run("stamp/synced-clears-dirty", () =>
    api.stampCardSyncState(snap([card("a","Q","A",{ dirty:true, updatedAt: OLD })]),
                           snap([card("a","Q","A",{ dirty:true, updatedAt: OLD })]), NEW, { synced: true }));
  ["a","b"].forEach((id, i) => {
    run("dirty/" + i, () => api.cardIsDirty(card(id,"Q","A",{ dirty: i === 0 })));
  });
  run("signature/stable", () => api.cardSyncSignature(card("a","Q","A",{ status:"known", category:"c" })));
  run("updatedMs/fallback", () => api.cardUpdatedMs(card("a","Q","A"), OLD));

  // ── tombstones ──────────────────────────────────────────────────────────
  run("tomb/record-deletions", () =>
    api.recordDeletedCardIds(snap([card("a","Q","A")]), snap([card("a","Q","A"), card("b","Q","A")]), NEW));
  run("tomb/drop-for-live-cards", () =>
    api.dropTombstonesForLiveCards(snap([card("b","Q","A")], { deletedCardIds: { b: NEW, c: NEW } })));
  run("tomb/prune-old", () =>
    api.pruneCardTombstones({ fresh: new Date().toISOString(), ancient: "2000-01-01T00:00:00.000Z" }));
  run("tomb/read-from-meta", () =>
    api.readCardTombstones(snap([], { deletedCardIds: { x: NEW } })));

  // ── payload shape ───────────────────────────────────────────────────────
  run("payload/normalize", () =>
    api.normalizeWebDeckPayload({ id:"d1", title:"T", category:"C", notes:"N", meta:{}, current_card_index:2 },
                                [row("a","Q","A", OLD, { position: 0 })]));
  run("payload/snapshot", () =>
    api.deckPayloadSnapshot({ deck:{ id:"d1", title:"T", category:"C", notes:"N", meta:{} },
                              cards:[card("a","Q","A")] }));
  run("payload/statusById", () => api.statusByIdFromCards([card("a","Q","A",{ status:"known" }), card("b","Q","A")]));
  run("payload/laterIso", () => api.laterIsoTimestamp(OLD, NEW) + "|" + api.laterIsoTimestamp(NEW, OLD));

  // ── restore merge (additive) ────────────────────────────────────────────
  const backupDeck = { id:"d1", title:"T", category:"C", notes:"backup notes", updatedAt: NEW,
                       cards:[{ id:"a", question:"backup Q", answer:"backup A", status:null },
                              { id:"z", question:"only in backup", answer:"A", status:null }] };
  run("restore/backup-newer", () =>
    api.mergeDeckSnapshots(snap([card("a","local Q","local A"), card("y","local only","A")]), backupDeck, true));
  run("restore/local-newer", () =>
    api.mergeDeckSnapshots(snap([card("a","local Q","local A"), card("y","local only","A")]), backupDeck, false));
  run("restore/empty-local", () => api.mergeDeckSnapshots(snap([]), backupDeck, true));
  run("restore/normalize-deck", () => api.normalizeBackupDeck(backupDeck, "Fallback"));

  // ── stats ───────────────────────────────────────────────────────────────
  run("stats/empty", () => api.emptySyncStats());
  run("stats/noop", () => api.isNoOpStats(api.emptySyncStats()));
  run("stats/tsMs", () => api.tsMs(OLD) + "|" + api.tsMs(null) + "|" + api.tsMs("nonsense"));

  // ── the guard constants ─────────────────────────────────────────────────
  run("guards/constants", () => ({
    sightings: api.MISSING_DECK_MIN_SIGHTINGS,
    ageMs: api.MISSING_DECK_MIN_AGE_MS,
    cap: api.ADOPT_DELETION_MIN_CAP,
    fraction: api.ADOPT_DELETION_MAX_FRACTION
  }));

  return out;
}`;

// Invariants checked against the CURRENT code only. Parity would be perfectly
// happy if both versions lost your library.
const INVARIANTS = String.raw`(api) => {
  const OLD = "2026-01-01T00:00:00.000Z";
  const NEW = "2026-12-01T00:00:00.000Z";
  const card = (id, q, a, extra = {}) => ({ id, question: q, answer: a, status: null, ...extra });
  const row  = (id, q, a, updated_at, extra = {}) => ({ id, question: q, answer: a, status: null, updated_at, ...extra });
  const snap = (cards, extra = {}) => ({ cards, meta: {}, ...extra });
  const results = [];
  // STRICTLY === true. Each check below is written as
  //   return <condition> || "what went wrong";
  // so a failure evaluates to a non-empty STRING — and Boolean("kept 0 of 3")
  // is true. Coercing here made every invariant pass unconditionally: deleting
  // the empty-cloud guard outright, the exact bug that once wiped a library,
  // was reported as 15/15 ok. The parity half caught it; this half was asleep.
  const must = (name, fn) => {
    try {
      const ok = fn();
      results.push([ok === true, name, ok === true ? "" : String(ok)]);
    } catch (e) { results.push([false, name, "THREW: " + e.message]); }
  };

  // 1. THE ONE THAT COST A LIBRARY. An empty cloud read must never be treated
  //    as "everything was deleted elsewhere".
  must("an empty cloud read keeps every local card", () => {
    const r = api.mergeCloudCardsIntoSnapshot(snap([card("a","Qa","Aa",{dirty:false,updatedAt:OLD}),
                                                    card("b","Qb","Ab",{dirty:false,updatedAt:OLD}),
                                                    card("c","Qc","Ac",{dirty:false,updatedAt:OLD})]), [], OLD);
    return r.cards.length === 3 || ("kept " + r.cards.length + " of 3");
  });
  must("an empty cloud read produces no card tombstones", () => {
    const r = api.mergeCloudCardsIntoSnapshot(snap([card("a","Qa","Aa")]), [], OLD);
    const n = Object.keys(r.deletedCardIds || {}).length;
    return n === 0 || ("recorded " + n + " tombstones");
  });
  must("a null/undefined cloud list keeps every local card", () => {
    const r = api.mergeCloudCardsIntoSnapshot(snap([card("a","Qa","Aa")]), null, OLD);
    return r.cards.length === 1 || ("kept " + r.cards.length + " of 1");
  });

  // 2. Unpushed local work is never discarded for a cloud that has not seen it.
  must("a dirty local card absent from the cloud survives", () => {
    const r = api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa",{dirty:false,updatedAt:OLD}), card("new","Qn","An",{dirty:true,updatedAt:NEW})]),
      [row("a","Qa","Aa", OLD)], OLD);
    return r.cards.some((c) => c.id === "new") || "the unpushed card was dropped";
  });
  must("a dirty local card newer than the cloud's copy wins", () => {
    const r = api.mergeCloudCardsIntoSnapshot(
      snap([card("a","MINE","A",{dirty:true,updatedAt:NEW})]), [row("a","THEIRS","A", OLD)], OLD);
    return r.cards[0].question === "MINE" || ("cloud overwrote a newer local edit: " + r.cards[0].question);
  });

  // 3. A deletion stays deleted.
  must("a tombstoned card is not resurrected from the cloud", () => {
    const r = api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa")], { deletedCardIds: { gone: NEW } }),
      [row("a","Qa","Aa", OLD), row("gone","Zombie","Back", OLD)], OLD);
    return !r.cards.some((c) => c.id === "gone") || "a deleted card came back";
  });

  // 4. A device-local link the cloud cannot carry is not lost on a pull.
  must("noteAnchor survives a pull that overwrites the card", () => {
    const r = api.mergeCloudCardsIntoSnapshot(
      snap([card("a","Qa","Aa",{dirty:false,updatedAt:OLD,noteAnchor:{offset:9,source:"s"}})]),
      [row("a","CLOUD","A", NEW)], OLD);
    return r.cards[0].noteAnchor?.offset === 9 || "the note anchor was lost";
  });

  // 5. Restore is ADDITIVE. A deck the backup does not mention, and a card only
  //    this device has, must both survive either direction of the merge.
  const backupDeck = { id:"d1", title:"T", category:"C", notes:"n", updatedAt: NEW,
                       cards:[{ id:"a", question:"backup Q", answer:"A", status:null }] };
  must("restore keeps a local-only card when the backup is newer", () => {
    const r = api.mergeDeckSnapshots(snap([card("a","local","A"), card("localonly","keep me","A")]), backupDeck, true);
    return r.snapshot.cards.some((c) => c.id === "localonly") || "a local-only card was dropped by restore";
  });
  must("restore keeps a local-only card when the backup is older", () => {
    const r = api.mergeDeckSnapshots(snap([card("a","local","A"), card("localonly","keep me","A")]), backupDeck, false);
    return r.snapshot.cards.some((c) => c.id === "localonly") || "a local-only card was dropped by restore";
  });
  must("an older backup does not overwrite a newer local card", () => {
    const r = api.mergeDeckSnapshots(snap([card("a","local wins","A")]), backupDeck, false);
    return r.snapshot.cards.find((c) => c.id === "a").question === "local wins" || "an older backup overwrote local work";
  });
  must("restore adds cards the backup has and local does not", () => {
    const r = api.mergeDeckSnapshots(snap([]), backupDeck, true);
    return r.snapshot.cards.some((c) => c.id === "a") || "restore added nothing";
  });

  // 6. The absence guards are still armed. These are constants, and a constant
  //    quietly reaching 1 or 0 is how an evidence-based rule becomes a guess.
  must("a missing deck needs more than one sighting", () =>
    api.MISSING_DECK_MIN_SIGHTINGS >= 2 || ("MISSING_DECK_MIN_SIGHTINGS = " + api.MISSING_DECK_MIN_SIGHTINGS));
  must("a missing deck must stay missing for minutes", () =>
    api.MISSING_DECK_MIN_AGE_MS >= 60000 || ("MISSING_DECK_MIN_AGE_MS = " + api.MISSING_DECK_MIN_AGE_MS));
  must("a bulk removal is capped", () =>
    (api.ADOPT_DELETION_MIN_CAP >= 1 && api.ADOPT_DELETION_MAX_FRACTION > 0 && api.ADOPT_DELETION_MAX_FRACTION <= 0.5)
    || ("cap=" + api.ADOPT_DELETION_MIN_CAP + " fraction=" + api.ADOPT_DELETION_MAX_FRACTION));

  // 7. Deleting a card records a tombstone, or the next pull brings it back.
  must("removing a card records a tombstone", () => {
    // Returns the mutated SNAPSHOT; the tombstones are on .deletedCardIds.
    const after = api.recordDeletedCardIds(snap([card("a","Q","A")]), snap([card("a","Q","A"), card("b","Q","A")]), NEW);
    return Boolean(after?.deletedCardIds?.b) || "no tombstone was recorded for the deleted card";
  });

  return results;
}`;


// Storage round-trip: real IndexedDB, real localStorage, current code only.
//
// Everything above is pure functions over JSON. This is where the decks
// actually LIVE — if a write silently no-ops or a read returns the wrong
// snapshot, the merge logic being perfect does not help.
const STORAGE = String.raw`async (api) => {
  const results = [];
  const must = async (name, fn) => {
    try {
      const ok = await fn();
      results.push([ok === true, name, ok === true ? "" : String(ok)]);
    } catch (e) { results.push([false, name, "THREW: " + e.message]); }
  };

  await api.initDeckStorage();

  const deck = {
    app: "recall", deckId: "d-test", deckTitle: "Round trip", deckCategory: "Cat",
    notes: "# notes\n\nbody", meta: { quickNoteCategories: [{ id: "c1", name: "N", color: "#fff" }] },
    cards: [
      { id: "a", question: "Qa", answer: "Aa", status: "known", category: null, dirty: true, updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "b", question: "Qb", answer: "Ab", status: null, category: "c1", noteAnchor: { offset: 4, source: "s" } }
    ],
    current: 1
  };

  await must("a deck written to IndexedDB reads back identical", async () => {
    await api.writeDeckSnapshot("local-1", deck);
    const back = await api.readDeckSnapshot("local-1");
    return JSON.stringify(back) === JSON.stringify(deck)
      || ("round trip differed: " + JSON.stringify(back).slice(0, 200));
  });

  await must("card flags survive the round trip", async () => {
    const back = await api.readDeckSnapshot("local-1");
    const a = back.cards.find((c) => c.id === "a");
    const b = back.cards.find((c) => c.id === "b");
    return (a.dirty === true && a.status === "known" && a.updatedAt === "2026-01-01T00:00:00.000Z"
            && b.noteAnchor?.offset === 4 && b.category === "c1")
      || ("flags lost: " + JSON.stringify({ a, b }));
  });

  await must("notes and meta survive the round trip", async () => {
    const back = await api.readDeckSnapshot("local-1");
    return (back.notes === deck.notes && back.meta.quickNoteCategories[0].id === "c1")
      || "notes or meta were lost";
  });

  await must("a written deck appears in the id list", async () => {
    const ids = await api.allDeckSnapshotIds();
    return ids.includes("local-1") || ("ids: " + JSON.stringify(ids));
  });

  await must("the returned snapshot is a COPY, not the stored object", async () => {
    const one = await api.readDeckSnapshot("local-1");
    one.cards[0].question = "MUTATED";
    const two = await api.readDeckSnapshot("local-1");
    return two.cards[0].question === "Qa"
      || "mutating a read snapshot corrupted the stored one";
  });

  await must("deleting removes it and leaves others alone", async () => {
    await api.writeDeckSnapshot("local-2", { ...deck, deckTitle: "Keep me" });
    await api.deleteDeckSnapshot("local-1");
    const ids = await api.allDeckSnapshotIds();
    const kept = await api.readDeckSnapshot("local-2");
    return (!ids.includes("local-1") && ids.includes("local-2") && kept.deckTitle === "Keep me")
      || ("after delete, ids = " + JSON.stringify(ids));
  });

  // ── deck-level tombstones (localStorage) ───────────────────────────────
  await must("a user deletion tombstones as 'user'", () => {
    api.clearDeckTombstone("d-x");
    api.tombstoneDeck("d-x", api.TOMBSTONE_ORIGIN_USER);
    return (api.isDeckTombstoned("d-x") === true && api.deckTombstoneOrigin("d-x") === api.TOMBSTONE_ORIGIN_USER)
      || ("origin = " + api.deckTombstoneOrigin("d-x"));
  });

  await must("an INFERRED deletion is recorded as inferred, not user", () => {
    api.clearDeckTombstone("d-y");
    api.tombstoneDeck("d-y", api.TOMBSTONE_ORIGIN_INFERRED);
    return api.deckTombstoneOrigin("d-y") === api.TOMBSTONE_ORIGIN_INFERRED
      || ("a guess was recorded as origin=" + api.deckTombstoneOrigin("d-y"));
  });

  await must("clearing a tombstone lets the deck come back", () => {
    api.tombstoneDeck("d-z", api.TOMBSTONE_ORIGIN_USER);
    api.clearDeckTombstone("d-z");
    return api.isDeckTombstoned("d-z") === false || "the tombstone survived being cleared";
  });

  // ── the missing-deck watch ─────────────────────────────────────────────
  await must("the missing-deck watch persists sightings", () => {
    api.writeMissingDeckWatch({ "d-w": { sightings: 1, firstMissingAt: 1000 } });
    const back = api.readMissingDeckWatch();
    return back["d-w"]?.sightings === 1 || ("watch read back as " + JSON.stringify(back));
  });

  await must("clearing the watch forgets the deck", () => {
    api.writeMissingDeckWatch({ "d-w": { sightings: 2, firstMissingAt: 1000 } });
    api.clearMissingDeckWatch("d-w");
    return api.readMissingDeckWatch()["d-w"] === undefined || "the watch entry survived being cleared";
  });

  await api.clearAllDeckSnapshots();
  return results;
}`;

function serve(dir, port) {
  return spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, String(port)], { stdio: "ignore" });
}

async function withPage(url, fn) {
  const browser = await puppeteer.launch({ headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await new Promise((r) => setTimeout(r, 800));
    return { value: await fn(page), errors };
  } finally {
    await browser.close();
  }
}

const servers = [];
const temps = [];
let failures = 0;
try {
  // Baseline: re-evaluate app.js inside a wrapper that hands the names back.
  const baseDir = mkdtempSync(path.join(tmpdir(), "recall-sync-"));
  temps.push(baseDir);
  execFileSync("bash", ["-c", `git archive ${BASE_REF} | tar -x -C ${baseDir}`], { cwd: ROOT });
  const appJs = readFileSync(path.join(baseDir, "app.js"), "utf8");
  writeFileSync(path.join(baseDir, "probe.js"),
    `window.__recallApi = (function () {\n${appJs}\n;return { ${API.join(", ")} };\n})();\n`);
  writeFileSync(path.join(baseDir, "index.html"),
    readFileSync(path.join(baseDir, "index.html"), "utf8")
      .replace('<script src="app.js?v=__BUILD__"></script>', '<script src="probe.js"></script>'));
  servers.push(serve(baseDir, 8091));
  servers.push(serve(ROOT, 8090));
  await new Promise((r) => setTimeout(r, 1500));

  const MODULE_API = `async () => {
    const mods = await Promise.all([
      import("/src/sync/diff.js"), import("/src/sync/cards.js"), import("/src/sync/stats.js"),
      import("/src/cloud/web-decks.js"), import("/src/backup/restore.js"),
      import("/src/backup/backup.js"), import("/src/storage/keys.js"),
      import("/src/export/markdown.js")
    ]);
    const api = {};
    for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
    return api;
  }`;

  const before = await withPage("http://127.0.0.1:8091/index.html", (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), SCENARIOS, "async () => window.__recallApi"));
  const after = await withPage("http://127.0.0.1:8090/index.html", (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), SCENARIOS, MODULE_API));

  const keys = [...new Set([...Object.keys(before.value), ...Object.keys(after.value)])].sort();
  const diffs = keys.filter((k) => before.value[k] !== after.value[k]);
  const threw = keys.filter((k) => String(after.value[k]).startsWith("THREW"));

  console.log("── parity against " + BASE_REF + " ──");
  for (const k of diffs.slice(0, 15)) {
    console.log(`  DIFF ${k}`);
    console.log(`    was: ${String(before.value[k]).slice(0, 260)}`);
    console.log(`    now: ${String(after.value[k]).slice(0, 260)}`);
  }
  if (diffs.length > 15) console.log(`  … and ${diffs.length - 15} more`);
  console.log(`  ${keys.length} sync scenarios · ${diffs.length} differ · ${threw.length} threw`);
  failures += diffs.length + threw.length;

  const inv = await withPage("http://127.0.0.1:8090/index.html", (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), INVARIANTS, MODULE_API));
  console.log("\n── data-loss invariants (current code) ──");
  for (const [ok, name, detail] of inv.value) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
    if (!ok) failures++;
  }
  const bad = inv.value.filter(([ok]) => !ok).length;
  console.log(`  ${inv.value.length} invariants · ${bad} violated`);

  const STORAGE_API = `async () => {
    const mods = await Promise.all([
      import("/src/storage/deck-store.js"), import("/src/library/tombstones.js"),
      import("/src/storage/keys.js")
    ]);
    const api = {};
    for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
    return api;
  }`;
  const store = await withPage("http://127.0.0.1:8090/index.html", (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), STORAGE, STORAGE_API));
  console.log("\n── storage round-trip (real IndexedDB / localStorage) ──");
  for (const [ok, name, detail] of store.value) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
    if (!ok) failures++;
  }
  const storeBad = store.value.filter(([ok]) => !ok).length;
  console.log(`  ${store.value.length} storage checks · ${storeBad} violated`);

  if (after.errors.length) console.log(`\n  page errors: ${after.errors.slice(0, 3).join(" | ")}`);
  console.log(failures ? `\n${failures} sync problem(s).` : "\nSync verified: identical behaviour, and every data-loss invariant holds.");
} finally {
  for (const s of servers) s.kill();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
