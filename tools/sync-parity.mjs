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
// The baseline is the TAG pre-modular, not a branch. It used to default to
// `main`, which stopped meaning anything the moment the restructure landed
// there — main became the thing under test, and the comparison had nothing
// left to compare against.
const BASE_REF = (process.argv.find((a) => a.startsWith("--base=")) || "--base=pre-modular").slice(7);

// Scenario keys that are EXPECTED to differ from pre-modular — a deliberate,
// reviewed behaviour change, not something the split broke. Mirrors
// boot-check.mjs's ACCEPTED_DIFFS. Keep this list one entry per intentional
// change, each with the "why" a diff alone can't say.
const ACCEPTED_DIFFS = {
  "stats/empty": "emptySyncStats() gained readingPositionSynced: a push/pull " +
    "whose only real change was the reader's last-seen position (meta.readingPosition) " +
    "used to report as a no-op ('already up to date') because nothing counted it. " +
    "The pre-modular baseline predates this field entirely. It gained three more " +
    "for the same reason — highlightsMerged, highlightsRemovedHere and " +
    "highlightNotesMerged — since a sync whose only news is that a paper's " +
    "annotations merged is now something the report can name rather than " +
    "something it had to call 'notes edited'."
};

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

  // 2b. The same promise, for a PDF deck's highlights.
  //
  //     meta is otherwise cloud-wins, which is fine for a reading position and
  //     fatal for an afternoon of highlighting: two devices reading the same
  //     paper each write a whole array, and taking one of them costs the other
  //     everything. Merged by id, newest \`at\` per id.
  must("highlights made on two devices are both kept", () => {
    const r = api.mergePdfHighlights([{ id: "h1", at: 1 }], [{ id: "h2", at: 2 }]);
    const ids = r.map((x) => x.id).sort().join(",");
    return ids === "h1,h2" || ("kept " + ids);
  });
  must("an empty cloud list does not erase this device's highlights", () => {
    const r = api.mergePdfHighlights([], [{ id: "h2", at: 2 }]);
    return (r.length === 1 && r[0].id === "h2") || ("kept " + JSON.stringify(r));
  });
  must("a cloud with no pdfHighlights key at all does not erase them either", () => {
    const r = api.mergePdfHighlights(undefined, [{ id: "h2", at: 2 }]);
    return (r && r.length === 1 && r[0].id === "h2") || ("kept " + JSON.stringify(r));
  });
  must("the newer edit to one highlight wins, whichever side it is on", () => {
    const a = api.mergePdfHighlights([{ id: "h", at: 1, color: "yellow" }], [{ id: "h", at: 9, color: "green" }]);
    const b = api.mergePdfHighlights([{ id: "h", at: 9, color: "green" }], [{ id: "h", at: 1, color: "yellow" }]);
    return (a[0].color === "green" && b[0].color === "green")
      || ("got " + a[0].color + " / " + b[0].color);
  });
  must("a deck that is not a PDF deck grows no pdfHighlights key", () => {
    const r = api.mergePdfHighlights(undefined, undefined);
    return r === null || ("returned " + JSON.stringify(r));
  });

  // 2c. ...and for the NOTES written on those highlights, which is the half that
  //     had nothing at all. A highlight's note text lives in the fenced block at
  //     the end of \`notes\`, and \`notes\` was whole-column last-write-wins on both
  //     sides: the pull replaced it with the cloud's and the push replaced the
  //     cloud's with this device's. Nothing merged it, so two devices annotating
  //     one paper destroyed each other's writing on every sync — and, because a
  //     PDF deck's body is essentially ONLY that block, raised a notes conflict
  //     every time as well. See src/sync/document-sync.js.
  const tailOf = (entries) => api.writeHighlightNoteEntries("", null, entries).replace(/\n$/, "");
  const noteAt = (source, id) => (api.parseHighlightNoteEntries(source).find((e) => e.id === id) || {}).text || "";

  must("a note written on each device survives the merge", () => {
    const cloud = tailOf([{ id: "hn-a", label: "", text: "theirs" }]);
    const local = tailOf([{ id: "hn-b", label: "", text: "mine" }]);
    const out = api.mergeHighlightNoteTails(cloud, local);
    return (noteAt(out.tail, "hn-a") === "theirs" && noteAt(out.tail, "hn-b") === "mine")
      || ("kept " + JSON.stringify(out.tail));
  });
  must("the newer noteAt wins two versions of ONE note", () => {
    const cloud = tailOf([{ id: "hn-a", label: "", text: "theirs" }]);
    const local = tailOf([{ id: "hn-a", label: "", text: "mine" }]);
    const out = api.mergeHighlightNoteTails(cloud, local, { stamps: { cloud: { "hn-a": 9 }, local: { "hn-a": 1 } } });
    return noteAt(out.tail, "hn-a") === "theirs" || ("kept " + noteAt(out.tail, "hn-a"));
  });
  must("with nothing to say which is newer, NEITHER text is dropped", () => {
    const cloud = tailOf([{ id: "hn-a", label: "", text: "theirs" }]);
    const local = tailOf([{ id: "hn-a", label: "", text: "mine" }]);
    const text = noteAt(api.mergeHighlightNoteTails(cloud, local).tail, "hn-a");
    return (text.indexOf("theirs") !== -1 && text.indexOf("mine") !== -1) || ("kept only " + JSON.stringify(text));
  });
  must("keeping both is order-independent, so two devices converge", () => {
    const cloud = tailOf([{ id: "hn-a", label: "", text: "theirs" }]);
    const local = tailOf([{ id: "hn-a", label: "", text: "mine" }]);
    const one = api.mergeHighlightNoteTails(cloud, local).tail;
    const two = api.mergeHighlightNoteTails(local, cloud).tail;
    return one === two || ("two devices produced different text: " + JSON.stringify([one, two]));
  });
  must("a deleted highlight's note goes with it, and stays gone", () => {
    const cloud = tailOf([{ id: "hn-a", label: "", text: "doomed" }]);
    const out = api.mergeHighlightNoteTails(cloud, cloud, { tombstones: { "hn-a": 9 } });
    return noteAt(out.tail, "hn-a") === "" || ("a deleted note came back: " + noteAt(out.tail, "hn-a"));
  });
  must("a tombstoned highlight is not resurrected by the other device's copy", () => {
    const r = api.mergePdfHighlights([{ id: "h", at: 1 }], [{ id: "h", at: 1 }], { tombstones: { h: 9 } });
    return r.length === 0 || ("kept " + JSON.stringify(r));
  });
  must("a recolour on one device and a note on the other both survive", () => {
    const r = api.mergePdfHighlights([{ id: "h", at: 9, color: "green" }], [{ id: "h", at: 1, color: "yellow", noteAt: 5 }]);
    return (r[0].color === "green" && r[0].noteAt === 5) || ("merged to " + JSON.stringify(r[0]));
  });
  must("a push reconciles the document against the cloud before sending it", () => {
    const cloudDeck = {
      notes: tailOf([{ id: "hn-a", label: "", text: "theirs" }]),
      meta: { pdfHighlights: [{ id: "h1", at: 1 }] }
    };
    const snapshot = {
      notes: tailOf([{ id: "hn-b", label: "", text: "mine" }]),
      meta: { pdfHighlights: [{ id: "h2", at: 2 }] }
    };
    const r = api.reconcileDocumentBeforePush(snapshot, cloudDeck);
    const ids = r.meta.pdfHighlights.map((x) => x.id).sort().join(",");
    return (ids === "h1,h2" && noteAt(r.notes, "hn-a") === "theirs" && noteAt(r.notes, "hn-b") === "mine")
      || ("about to push " + ids + " / " + JSON.stringify(r.notes));
  });
  must("a push against a row with no notes column reconciles nothing", () => {
    const r = api.reconcileDocumentBeforePush(
      { notes: tailOf([{ id: "hn-b", label: "", text: "mine" }]), meta: { pdfHighlights: [{ id: "h2", at: 2 }] } },
      { meta: {} });
    return r === null || ("merged against a row that carried no body: " + JSON.stringify(r));
  });
  must("an ordinary deck's push is not touched by any of this", () => {
    const r = api.reconcileDocumentBeforePush({ notes: "# plain", meta: {} }, { notes: "# plain", meta: {} });
    return r === null || ("returned " + JSON.stringify(r));
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
// ── Concurrency and batching ────────────────────────────────────────────────
// Two things in the sync were made faster in ways that could, done wrong, cost
// data rather than time. Neither is visible to the parity comparison — the
// baseline has no equivalent to compare against — so they are asserted here on
// their own terms, exactly as the invariants above are.
//
//   1. The chunked cloud READS (fetchCloudDeckRows, fetchCardsForDecks) run
//      through mapWithConcurrency instead of a sequential for-await. Their
//      results are read as facts about what exists in the cloud — a deck
//      missing from the map means "deleted", a card missing means "delete this
//      card" — so a chunk that fails MUST take the whole read down with it. A
//      partial answer is not slower, it is wrong, and it is wrong in the one
//      direction this app has already lost a library to.
//
//   2. The deck index is written in batches, because a 700-deck pull otherwise
//      did 700 synchronous whole-library writes to localStorage. The batch must
//      be invisible to every reader, and it must not be able to strand data.
const CONCURRENCY = String.raw`async (api) => {
  const results = [];
  const must = async (name, fn) => {
    try {
      const ok = await fn();
      results.push([ok === true, name, ok === true ? "" : String(ok)]);
    } catch (e) { results.push([false, name, "THREW: " + e.message]); }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await must("concurrent reads come back in INPUT order, not completion order", async () => {
    // Deliberately inverted: the first item takes longest. A naive
    // "push as they finish" would return them backwards, and the callers build
    // id-keyed maps from these, so a reordering would silently mis-key them.
    const items = [40, 30, 20, 10, 0];
    const out = await api.mapWithConcurrency(items, 3, async (ms) => { await sleep(ms); return ms; });
    return JSON.stringify(out) === JSON.stringify(items)
      || ("got " + JSON.stringify(out));
  });

  await must("never more than the concurrency limit is in flight", async () => {
    let live = 0, peak = 0;
    await api.mapWithConcurrency([1,2,3,4,5,6,7,8,9,10], 4, async () => {
      live++; peak = Math.max(peak, live);
      await sleep(15);
      live--;
    });
    return peak <= 4 || ("peak concurrency was " + peak);
  });

  await must("a failing chunk rejects the WHOLE read", async () => {
    // The guarantee mergeCloudCardsIntoSnapshot depends on. If this ever
    // resolves with the surviving chunks instead, a dropped chunk becomes a
    // batch of cards the merge deletes.
    let resolved = false;
    try {
      await api.mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
        if (n === 2) throw new Error("chunk failed");
        await sleep(5);
        return n;
      });
      resolved = true;
    } catch (e) {
      return /chunk failed/.test(e.message) || ("wrong error: " + e.message);
    }
    return resolved ? "it resolved with a partial result instead of throwing" : "no error";
  });

  await must("a second failure does not surface as an unhandled rejection", async () => {
    let unhandled = null;
    const onUnhandled = (event) => { unhandled = String(event.reason && event.reason.message); };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      await api.mapWithConcurrency([1, 2, 3, 4], 4, async (n) => {
        await sleep(n * 5);
        throw new Error("fail " + n);
      });
    } catch (_) { /* expected */ }
    await sleep(120);
    window.removeEventListener("unhandledrejection", onUnhandled);
    return unhandled === null || ("unhandled rejection escaped: " + unhandled);
  });

  // ── the batched deck index ────────────────────────────────────────────────
  const entries = (n) => Array.from({ length: n }, (_, i) => ({
    id: "local-" + i, deckId: "cloud-" + i, title: "Deck " + i,
    updatedAt: "2026-01-0" + ((i % 9) + 1) + "T00:00:00.000Z", lastSyncedAt: "2026-01-01T00:00:00.000Z"
  }));

  await must("batched writes produce an index identical to unbatched ones", async () => {
    const list = entries(60);
    // Unbatched, one write per deck, exactly as the old pull loop did.
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    for (let i = 0; i < list.length; i++) api.writeLocalDeckIndex(list.slice(0, i + 1));
    const unbatched = localStorage.getItem("flashcards_local_decks_index_v1");

    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.beginIndexBatch();
    for (let i = 0; i < list.length; i++) api.writeLocalDeckIndex(list.slice(0, i + 1));
    api.endIndexBatch();
    const batched = localStorage.getItem("flashcards_local_decks_index_v1");

    return batched === unbatched || "the batched index differs from the unbatched one";
  });

  await must("a read during a batch sees the pending writes", async () => {
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.beginIndexBatch();
    api.writeLocalDeckIndex(entries(3));
    const seen = api.readLocalDeckIndex();
    api.endIndexBatch();
    return seen.length === 3 || ("read " + seen.length + " entries mid-batch, expected 3");
  });

  await must("readLocalDeckIndex still returns a FRESH array, batch or no batch", async () => {
    // 48 call sites read this and some of them mutate what they get. Handing
    // out a shared array would be faster and would make one caller's edit
    // visible to every other reader without anything having been saved.
    api.discardIndexBatch();
    api.beginIndexBatch();
    api.writeLocalDeckIndex(entries(3));
    const first = api.readLocalDeckIndex();
    first[0].title = "MUTATED";
    first.pop();
    const second = api.readLocalDeckIndex();
    api.endIndexBatch();
    return (second.length === 3 && second[0].title === "Deck 0")
      || ("a mutation leaked between reads: " + JSON.stringify(second).slice(0, 120));
  });

  await must("a batch checkpoints, so a crash cannot strand the whole run", async () => {
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.beginIndexBatch();
    // One more write than a checkpoint interval, then NO flush — the tab dying
    // mid-sync. What is on disk must be the checkpoint, not nothing.
    const n = api.INDEX_CHECKPOINT_EVERY + 1;
    for (let i = 0; i < n; i++) api.writeLocalDeckIndex(entries(i + 1));
    const onDisk = JSON.parse(localStorage.getItem("flashcards_local_decks_index_v1") || "[]");
    api.discardIndexBatch();
    return onDisk.length === api.INDEX_CHECKPOINT_EVERY
      || ("expected the checkpoint to have persisted " + api.INDEX_CHECKPOINT_EVERY + " entries, found " + onDisk.length);
  });

  await must("flushIndexBatch persists what is pending", async () => {
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.beginIndexBatch();
    api.writeLocalDeckIndex(entries(4));
    api.flushIndexBatch();
    const onDisk = JSON.parse(localStorage.getItem("flashcards_local_decks_index_v1") || "[]");
    api.discardIndexBatch();
    return onDisk.length === 4 || ("found " + onDisk.length + " entries on disk");
  });

  await must("discardIndexBatch throws the pending copy away", async () => {
    // resetLocalLibrary deletes the index key on an account switch. A pending
    // batch flushed afterwards would write the PREVIOUS account's library
    // straight back over the removal.
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.beginIndexBatch();
    api.writeLocalDeckIndex(entries(5));
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.flushIndexBatch();
    return localStorage.getItem("flashcards_local_decks_index_v1") === null
      || "a discarded batch was written back anyway";
  });

  await must("nested batches only flush at the outermost end", async () => {
    // The reconcile opens one for the pull pass and one for the push pass, and
    // closes both in its finally. A count that drifted would leave a batch open
    // for the life of the page, and every later deck save would live in memory
    // and never reach disk.
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.beginIndexBatch();
    api.beginIndexBatch();
    api.writeLocalDeckIndex(entries(2));
    api.endIndexBatch();
    const midway = localStorage.getItem("flashcards_local_decks_index_v1");
    api.endIndexBatch();
    const after = JSON.parse(localStorage.getItem("flashcards_local_decks_index_v1") || "[]");
    return (midway === null && after.length === 2)
      || ("midway=" + String(midway).slice(0, 40) + " after=" + after.length);
  });

  await must("writes outside a batch still go straight to disk", async () => {
    api.discardIndexBatch();
    localStorage.removeItem("flashcards_local_decks_index_v1");
    api.writeLocalDeckIndex(entries(7));
    const onDisk = JSON.parse(localStorage.getItem("flashcards_local_decks_index_v1") || "[]");
    return onDisk.length === 7 || ("found " + onDisk.length + " entries on disk");
  });

  localStorage.removeItem("flashcards_local_decks_index_v1");
  return results;
}`;

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

// Start a server on a FREE port and resolve to its URL base. Fixed ports made
// these checks quietly unreliable — a server left behind by an interrupted run
// keeps the port, the new bind fails, and the stale one answers from a
// different tree.
function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
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
  const __s_baseDir = await serveOn(baseDir); servers.push(__s_baseDir.proc);
  const __s_ROOT = await serveOn(ROOT); servers.push(__s_ROOT.proc);
  await new Promise((r) => setTimeout(r, 1500));

  // NOTE: ?v=__BUILD__ on every import, matching what the app's own modules ask
  // for. A module's URL is its identity — importing "/src/cloud/supabase-client.js"
  // and "/src/cloud/supabase-client.js?v=__BUILD__" yields TWO instances with
  // separate state. Without the stamp this harness set the client on one
  // instance while reconcile read from another, saw none, and returned
  // immediately: every scenario "passed" by doing nothing at all.
  const MODULE_API = `async () => {
    const mods = await Promise.all([
      import("/src/sync/diff.js?v=__BUILD__"), import("/src/sync/cards.js?v=__BUILD__"), import("/src/sync/stats.js?v=__BUILD__"),
      import("/src/cloud/web-decks.js?v=__BUILD__"), import("/src/backup/restore.js?v=__BUILD__"),
      import("/src/backup/backup.js?v=__BUILD__"), import("/src/storage/keys.js?v=__BUILD__"),
      import("/src/export/markdown.js?v=__BUILD__"),
      // Current-code-only, for the document invariants: nothing in the
      // pre-modular baseline has an equivalent, so these never take part in the
      // parity comparison above.
      import("/src/sync/document-sync.js?v=__BUILD__"),
      import("/src/format/highlight-notes-merge.js?v=__BUILD__")
    ]);
    const api = {};
    for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
    return api;
  }`;

  const before = await withPage(`${__s_baseDir.base}/index.html`, (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), SCENARIOS, "async () => window.__recallApi"));
  const after = await withPage(`${__s_ROOT.base}/index.html`, (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), SCENARIOS, MODULE_API));

  const keys = [...new Set([...Object.keys(before.value), ...Object.keys(after.value)])].sort();
  const changed = keys.filter((k) => before.value[k] !== after.value[k]);
  const diffs = changed.filter((k) => !(k in ACCEPTED_DIFFS));
  const accepted = changed.filter((k) => k in ACCEPTED_DIFFS);
  const threw = keys.filter((k) => String(after.value[k]).startsWith("THREW"));

  console.log("── parity against " + BASE_REF + " ──");
  for (const k of diffs.slice(0, 15)) {
    console.log(`  DIFF ${k}`);
    console.log(`    was: ${String(before.value[k]).slice(0, 260)}`);
    console.log(`    now: ${String(after.value[k]).slice(0, 260)}`);
  }
  if (diffs.length > 15) console.log(`  … and ${diffs.length - 15} more`);
  if (accepted.length) {
    console.log("── accepted differences ──");
    for (const k of accepted) {
      console.log(`  ${k}`);
      console.log(`    was: ${String(before.value[k]).slice(0, 260)}`);
      console.log(`    now: ${String(after.value[k]).slice(0, 260)}`);
      console.log(`    why: ${ACCEPTED_DIFFS[k]}`);
    }
  }
  console.log(`  ${keys.length} sync scenarios · ${diffs.length} differ · ${threw.length} threw`);
  failures += diffs.length + threw.length;

  const inv = await withPage(`${__s_ROOT.base}/index.html`, (p) =>
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
      import("/src/storage/deck-store.js?v=__BUILD__"), import("/src/library/tombstones.js?v=__BUILD__"),
      import("/src/storage/keys.js?v=__BUILD__")
    ]);
    const api = {};
    for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
    return api;
  }`;
  const store = await withPage(`${__s_ROOT.base}/index.html`, (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), STORAGE, STORAGE_API));
  console.log("\n── storage round-trip (real IndexedDB / localStorage) ──");
  for (const [ok, name, detail] of store.value) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
    if (!ok) failures++;
  }
  const storeBad = store.value.filter(([ok]) => !ok).length;
  console.log(`  ${store.value.length} storage checks · ${storeBad} violated`);

  const CONCURRENCY_API = `async () => {
    const mods = await Promise.all([
      import("/src/cloud/net.js?v=__BUILD__"), import("/src/library/local-library.js?v=__BUILD__")
    ]);
    const api = {};
    for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
    return api;
  }`;
  const conc = await withPage(`${__s_ROOT.base}/index.html`, (p) =>
    p.evaluate(async (src, api) => (0, eval)("(" + src + ")")(await (0, eval)(api)()), CONCURRENCY, CONCURRENCY_API));
  console.log("\n── concurrency & batched index writes ──");
  for (const [ok, name, detail] of conc.value) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
    if (!ok) failures++;
  }
  const concBad = conc.value.filter(([ok]) => !ok).length;
  console.log(`  ${conc.value.length} concurrency checks · ${concBad} violated`);

  if (after.errors.length) console.log(`\n  page errors: ${after.errors.slice(0, 3).join(" | ")}`);
  console.log(failures ? `\n${failures} sync problem(s).` : "\nSync verified: identical behaviour, and every data-loss invariant holds.");
} finally {
  for (const s of servers) s.kill();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
