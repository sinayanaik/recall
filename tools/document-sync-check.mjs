// Does a paper's highlights and notes actually reach the other device?
//
//   node tools/document-sync-check.mjs
//
// The reported failure was deterministic, not a race: highlights and notes made
// on one device never arrived on the other, and the deck raised a notes conflict
// on every single sync. Both came from one cause — a document's annotations rode
// on the last part of a deck that was still whole-column last-write-wins — and
// the fix gives them what a CARD already had: a per-record timestamp, a merge on
// the pull, a reconcile before the push, and a tombstone for a deletion.
//
// So this drives two simulated devices and one in-memory "cloud" row through the
// REAL merge functions, in the real order the reconcile calls them, and asserts
// on the state all three end in. Every case below fails against the code as it
// was before this change.
//
// ── Why this runs in plain Node, and sync-parity.mjs does not ─────────────
//
// tools/sync-parity.mjs boots the app in Chrome because half of what it checks
// is a comparison against `git archive pre-modular`, a tag that not every clone
// carries, and because it needs IndexedDB and localStorage for real. Nothing
// here needs any of that: src/format/highlight-notes-merge.js and
// src/sync/document-sync.js are pure functions of strings and plain objects,
// deliberately (see those files' headers). Importing them directly means this
// check runs everywhere, in milliseconds, with no browser and no baseline — and
// a check that can only skip is a check that verifies nothing.
//
// The one accommodation: every import in src/ carries `?v=__BUILD__`, which is a
// cache-busting query the static server understands and Node's ESM resolver does
// not. The tree is copied to a temp directory with the stamp removed, exactly as
// the deploy step rewrites it.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-docsync-"));

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

let results = [];
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
  // The modules under test touch none of this. Their IMPORTS do: src/core/dom.js
  // runs a hundred querySelector calls at module scope, and it is three or four
  // hops up from src/sync/stats.js. Rather than shape the source around what
  // Node happens to provide, stand up the few globals an import-time evaluation
  // reaches for and let the real module graph load unchanged — a stub that is
  // ever actually CALLED would be a check testing its own scaffolding, so every
  // one of these returns the empty answer and nothing here asserts on it.
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

  const load = (rel) => import(path.join(stage, rel));

  const fence = await load("src/format/notes-fence.js");
  const merge = await load("src/format/highlight-notes-merge.js");
  const docSync = await load("src/sync/document-sync.js");
  const diff = await load("src/sync/diff.js");

  const T1 = 1_800_000_000_000;
  const T2 = T1 + 60_000;
  const T3 = T1 + 120_000;

  // ── The world ───────────────────────────────────────────────────────────
  //
  // One cloud row {notes, meta}, and two devices each holding a snapshot of it.
  // pull() and push() call exactly what src/sync/reconcile.js calls, in the same
  // order, so a case that passes here is a case the app passes.
  const highlight = (id, page, at, extra = {}) => ({
    id, page, color: "yellow", kind: "text", text: `words on ${page}`,
    quads: [{ page, x: 0, y: 0, w: 1, h: 1 }], at, ...extra
  });
  const noteTail = (entries) => merge.writeHighlightNoteEntries("", null, entries).replace(/\n$/, "");
  const withNotes = (body, entries) => fence.joinHighlightNotesTail(body, noteTail(entries));

  const device = (name, notes = "", meta = {}) => ({ name, notes, meta, stash: null, conflicted: false });
  const clone = (value) => JSON.parse(JSON.stringify(value));

  // The pull, as pullCloudDeckIntoLibraryLocked runs it: merge the annotations,
  // take the cloud's body, then ask the conflict question of the BODY only.
  function pull(dev, cloud) {
    const merged = docSync.mergeDocumentAnnotations({
      cloudNotes: cloud.notes,
      cloudMeta: cloud.meta,
      localNotes: dev.notes,
      localMeta: dev.meta,
      body: "cloud",
      extraTails: dev.stash ? [fence.splitHighlightNotesTail(dev.stash).tail] : []
    });
    const oldBody = fence.readerNotesBody(dev.notes);
    const newBody = fence.readerNotesBody(merged.notes);
    const bodyChanged = diff.syncTextChanged(oldBody, newBody);
    if (bodyChanged && oldBody.trim()) {
      dev.conflicted = true;
      dev.stash = dev.notes;
    } else if (dev.stash && !diff.syncTextChanged(fence.readerNotesBody(dev.stash), newBody)) {
      dev.stash = null;
      dev.conflicted = false;
    }
    dev.notes = merged.notes;
    const meta = { ...dev.meta };
    if (merged.pdfHighlights) meta.pdfHighlights = merged.pdfHighlights;
    if (Object.keys(merged.deletedHighlightIds).length) meta.deletedHighlightIds = merged.deletedHighlightIds;
    else delete meta.deletedHighlightIds;
    dev.meta = meta;
    return { ...merged, bodyChanged, conflicted: dev.conflicted };
  }

  // The push, as pushLibraryDeckToCloud runs it: reconcile against the cloud's
  // real row first, write the result back locally, THEN send.
  function push(dev, cloud) {
    const snapshot = { notes: dev.notes, meta: clone(dev.meta) };
    const reconciled = docSync.reconcileDeckBeforePush(snapshot, cloud);
    if (reconciled) {
      dev.notes = reconciled.notes;
      dev.meta = reconciled.meta;
    }
    cloud.notes = dev.notes;
    cloud.meta = clone(dev.meta);
    // Retired only AFTER the row has landed, exactly as pushLibraryDeckToCloud
    // does it — the tombstone has to be in what the cloud receives, or the other
    // device never hears about the deletion at all.
    for (const id of reconciled?.tombstonesBeingPruned || []) delete dev.meta.deletedHighlightIds?.[id];
    if (dev.meta.deletedHighlightIds && !Object.keys(dev.meta.deletedHighlightIds).length) delete dev.meta.deletedHighlightIds;
    return reconciled;
  }

  const idsIn = (dev) => (dev.meta.pdfHighlights || []).map((r) => r.id).sort().join(",");
  const noteFor = (dev, id) => merge.parseHighlightNoteEntries(dev.notes).find((e) => e.id === id)?.text || "";

  // ── 1. Two devices annotate different pages, neither pulls first ────────
  {
    const cloud = { notes: "", meta: {} };
    const a = device("A");
    const b = device("B");
    a.meta = { pdf: { name: "p.pdf" }, pdfHighlights: [highlight("hn-aaa111", 1, T1, { noteAt: T1 })] };
    a.notes = withNotes("", [{ id: "hn-aaa111", label: "“p1”", text: "A's note on page 1" }]);
    push(a, cloud);

    // B never pulls — it has a local edit stamped later, so the reconcile's pull
    // gate skips it. This is the exact shape of the reported bug.
    b.meta = { pdf: { name: "p.pdf" }, pdfHighlights: [highlight("hn-bbb222", 2, T2, { noteAt: T2 })] };
    b.notes = withNotes("", [{ id: "hn-bbb222", label: "“p2”", text: "B's note on page 2" }]);
    const pushed = push(b, cloud);
    pull(a, cloud);

    must("B's push keeps A's highlight instead of overwriting it", () =>
      idsIn(b) === "hn-aaa111,hn-bbb222" || `B holds ${idsIn(b)}`);
    must("the cloud ends with both highlights", () =>
      (cloud.meta.pdfHighlights || []).length === 2 || `cloud holds ${(cloud.meta.pdfHighlights || []).length}`);
    must("A's next pull still has both highlights", () =>
      idsIn(a) === "hn-aaa111,hn-bbb222" || `A holds ${idsIn(a)}`);
    must("both notes survive on both devices", () => {
      const texts = [noteFor(a, "hn-aaa111"), noteFor(a, "hn-bbb222"), noteFor(b, "hn-aaa111"), noteFor(b, "hn-bbb222")];
      return texts.every(Boolean) || `notes: ${JSON.stringify(texts)}`;
    });
    must("the push reports what it merged in", () =>
      (pushed.highlightsAdopted === 1) || `adopted ${pushed?.highlightsAdopted}`);
  }

  // ── 2. The reported bug: a note per device, and no conflict raised ──────
  {
    const cloud = { notes: "", meta: {} };
    const a = device("A");
    const b = device("B");
    const shared = [highlight("hn-aaa111", 1, T1), highlight("hn-bbb222", 2, T1)];
    a.meta = { pdfHighlights: clone(shared) };
    b.meta = { pdfHighlights: clone(shared) };
    a.notes = withNotes("", [{ id: "hn-aaa111", label: "“p1”", text: "A wrote this" }]);
    a.meta.pdfHighlights = a.meta.pdfHighlights.map((r) => r.id === "hn-aaa111" ? { ...r, noteAt: T2 } : r);
    b.notes = withNotes("", [{ id: "hn-bbb222", label: "“p2”", text: "B wrote this" }]);
    b.meta.pdfHighlights = b.meta.pdfHighlights.map((r) => r.id === "hn-bbb222" ? { ...r, noteAt: T2 } : r);

    push(a, cloud);
    push(b, cloud);
    const pulled = pull(a, cloud);

    must("no conflict is raised when only annotations differ", () =>
      (pulled.conflicted === false && pulled.bodyChanged === false) || `conflicted=${pulled.conflicted} bodyChanged=${pulled.bodyChanged}`);
    must("no stash is written for an annotations-only sync", () =>
      a.stash === null || "a stash was written");
    must("each device ends holding both notes", () =>
      (noteFor(a, "hn-aaa111") === "A wrote this" && noteFor(a, "hn-bbb222") === "B wrote this"
        && noteFor(b, "hn-aaa111") === "A wrote this" && noteFor(b, "hn-bbb222") === "B wrote this")
      || `A: ${JSON.stringify([noteFor(a, "hn-aaa111"), noteFor(a, "hn-bbb222")])} B: ${JSON.stringify([noteFor(b, "hn-aaa111"), noteFor(b, "hn-bbb222")])}`);
  }

  // ── 3. Both devices edit the SAME note ──────────────────────────────────
  {
    const stamped = (at) => ({ stamps: { cloud: { "hn-aaa111": at.cloud }, local: { "hn-aaa111": at.local } } });
    const cloudTail = noteTail([{ id: "hn-aaa111", label: "“p1”", text: "the cloud's version" }]);
    const localTail = noteTail([{ id: "hn-aaa111", label: "“p1”", text: "this device's version" }]);

    must("the newer noteAt wins a genuine conflict", () => {
      const newer = merge.mergeHighlightNoteTails(cloudTail, localTail, stamped({ cloud: T3, local: T1 }));
      const older = merge.mergeHighlightNoteTails(cloudTail, localTail, stamped({ cloud: T1, local: T3 }));
      return (merge.parseHighlightNoteEntries(newer.tail)[0].text === "the cloud's version"
        && merge.parseHighlightNoteEntries(older.tail)[0].text === "this device's version")
        || `newer=${JSON.stringify(merge.parseHighlightNoteEntries(newer.tail)[0].text)}`;
    });

    must("with no stamp to settle it, BOTH texts survive", () => {
      const both = merge.mergeHighlightNoteTails(cloudTail, localTail);
      const text = merge.parseHighlightNoteEntries(both.tail)[0].text;
      return (text.includes("the cloud's version") && text.includes("this device's version"))
        || `kept only: ${JSON.stringify(text)}`;
    });

    must("keeping both is order-independent, so two devices converge", () => {
      const one = merge.mergeHighlightNoteTails(cloudTail, localTail).tail;
      const two = merge.mergeHighlightNoteTails(localTail, cloudTail).tail;
      return one === two || `A produced ${JSON.stringify(one)}, B produced ${JSON.stringify(two)}`;
    });

    must("re-merging a kept-both entry does not nest it again", () => {
      const once = merge.mergeHighlightNoteTails(cloudTail, localTail).tail;
      const twice = merge.mergeHighlightNoteTails(once, localTail).tail;
      return twice === once || `second pass changed it: ${JSON.stringify(twice)}`;
    });
  }

  // ── 4. A recolour on one device, a note on the other ────────────────────
  {
    const recoloured = [{ ...highlight("hn-aaa111", 1, T1), color: "green", at: T3 }];
    const annotated = [{ ...highlight("hn-aaa111", 1, T1), noteAt: T2 }];
    const merged = diff.mergePdfHighlights(recoloured, annotated);

    must("a recolour and a note on the same highlight both survive", () =>
      (merged[0].color === "green" && merged[0].noteAt === T2)
      || `merged to ${JSON.stringify(merged[0])}`);

    must("the note's own stamp is what settles its text, not the recolour", () => {
      const cloudTail = noteTail([{ id: "hn-aaa111", label: "“p1”", text: "the note" }]);
      const out = merge.mergeHighlightNoteTails(cloudTail, "", {
        stamps: { cloud: docSync.highlightNoteStamps(annotated), local: {} }
      });
      return merge.parseHighlightNoteEntries(out.tail)[0]?.text === "the note"
        || `lost the note: ${JSON.stringify(out.tail)}`;
    });
  }

  // ── 5. A deletion stays deleted, and takes its note with it ─────────────
  {
    const cloud = { notes: "", meta: {} };
    const a = device("A");
    const b = device("B");
    a.meta = { pdfHighlights: [highlight("hn-aaa111", 1, T1, { noteAt: T1 }), highlight("hn-bbb222", 2, T1)] };
    a.notes = withNotes("", [{ id: "hn-aaa111", label: "“p1”", text: "doomed" }]);
    push(a, cloud);
    pull(b, cloud);

    // A deletes it — the tombstone and the note prune, as removeDocumentHighlight
    // writes them.
    a.meta = {
      ...a.meta,
      pdfHighlights: a.meta.pdfHighlights.filter((r) => r.id !== "hn-aaa111"),
      deletedHighlightIds: docSync.recordDeletedHighlightId(a.meta, "hn-aaa111", new Date(T2).toISOString())
    };
    a.notes = withNotes("", []);
    push(a, cloud);

    // B still holds its stale copy and pushes without pulling.
    const bPush = push(b, cloud);
    must("B's push does not resurrect the highlight A deleted", () =>
      idsIn(b) === "hn-bbb222" || `B holds ${idsIn(b)}`);
    must("B's push does not resurrect its note either", () =>
      noteFor(b, "hn-aaa111") === "" || `B still has: ${noteFor(b, "hn-aaa111")}`);
    must("the deletion is reported, not silent", () =>
      bPush.highlightsRemoved === 1 || `removed ${bPush?.highlightsRemoved}`);

    pull(a, cloud);
    must("A's next pull does not adopt it back from B", () =>
      idsIn(a) === "hn-bbb222" || `A holds ${idsIn(a)}`);
    must("the cloud is left without it too", () =>
      !(cloud.meta.pdfHighlights || []).some((r) => r.id === "hn-aaa111") || "the cloud still has it");
  }

  // ── 6. A genuinely different BODY must still conflict ──────────────────
  {
    const cloud = { notes: "# The cloud's writing\n\nquite different", meta: {} };
    const a = device("A", "# My writing\n\nwhat I wrote");
    const pulled = pull(a, cloud);
    must("a real body difference still raises a conflict", () =>
      pulled.conflicted === true || "the conflict was swallowed");
    must("a real body difference still stashes the losing copy", () =>
      (a.stash || "").includes("what I wrote") || `stash: ${JSON.stringify(a.stash)}`);
  }

  // ── 7. An existing stash is folded back in, and clears ─────────────────
  {
    const cloud = {
      notes: withNotes("shared body", [{ id: "hn-bbb222", label: "“p2”", text: "from the other device" }]),
      meta: { pdfHighlights: [highlight("hn-aaa111", 1, T1), highlight("hn-bbb222", 2, T1)] }
    };
    const a = device("A", withNotes("shared body", []));
    a.meta = { pdfHighlights: [highlight("hn-aaa111", 1, T1)] };
    // Stranded by an earlier last-write-wins clobber: same body, annotations the
    // device no longer has anywhere else.
    a.stash = withNotes("shared body", [{ id: "hn-aaa111", label: "“p1”", text: "rescued from the stash" }]);
    a.conflicted = true;
    pull(a, cloud);

    must("annotations stranded in the stash come back", () =>
      noteFor(a, "hn-aaa111") === "rescued from the stash" || `got ${JSON.stringify(noteFor(a, "hn-aaa111"))}`);
    must("the other device's note arrives in the same pull", () =>
      noteFor(a, "hn-bbb222") === "from the other device" || `got ${JSON.stringify(noteFor(a, "hn-bbb222"))}`);
    must("a stash whose body matched is cleared", () =>
      (a.stash === null && a.conflicted === false) || `stash=${a.stash === null ? "cleared" : "kept"} flag=${a.conflicted}`);
  }

  // ── 8. Convergence: the second round is a no-op ────────────────────────
  {
    const cloud = { notes: "", meta: {} };
    const a = device("A");
    const b = device("B");
    a.meta = { pdfHighlights: [highlight("hn-aaa111", 1, T1, { noteAt: T1 })] };
    a.notes = withNotes("body", [{ id: "hn-aaa111", label: "“p1”", text: "A" }]);
    b.meta = { pdfHighlights: [highlight("hn-bbb222", 2, T2, { noteAt: T2 })] };
    b.notes = withNotes("body", [{ id: "hn-bbb222", label: "“p2”", text: "B" }]);

    push(a, cloud); push(b, cloud); pull(a, cloud); push(a, cloud); pull(b, cloud);
    const settled = { a: a.notes, b: b.notes, cloud: cloud.notes, meta: JSON.stringify(cloud.meta) };
    push(a, cloud); pull(b, cloud); push(b, cloud); pull(a, cloud);

    must("a second round changes nothing on either device", () =>
      (a.notes === settled.a && b.notes === settled.b)
      || `A ${a.notes === settled.a ? "held" : "moved"}, B ${b.notes === settled.b ? "held" : "moved"}`);
    must("a second round changes nothing in the cloud", () =>
      (cloud.notes === settled.cloud && JSON.stringify(cloud.meta) === settled.meta)
      || "the cloud kept moving");
    must("both devices agree on the final text", () =>
      fence.readerNotesBody(a.notes) === fence.readerNotesBody(b.notes)
        && merge.parseHighlightNoteEntries(a.notes).length === merge.parseHighlightNoteEntries(b.notes).length
      || `A: ${JSON.stringify(a.notes)}\n     B: ${JSON.stringify(b.notes)}`);
  }

  // ── 9. An ordinary deck is untouched ───────────────────────────────────
  {
    const cloud = { notes: "# A normal note\n\nwith no highlights", meta: {} };
    const a = device("A", "# A normal note\n\nwith no highlights");
    must("a deck with no annotations grows no keys and moves nothing", () => {
      const pulled = pull(a, cloud);
      const pushed = push(a, cloud);
      // The push used to return null here and the deck's whole meta then went to
      // the cloud unmerged — see mergeDeckMeta. It reconciles every
      // deck now; what must stay true is that a deck with nothing on either side
      // grows no keys and reports `changed: false`, so no snapshot is rewritten.
      return (pulled.pdfHighlights === null && pushed && pushed.changed === false
        && !("pdfHighlights" in a.meta) && !("deletedHighlightIds" in a.meta))
        || `meta: ${JSON.stringify(a.meta)}, push: ${JSON.stringify(pushed)}`;
    });

    // ── 9b. The rest of the meta bag ────────────────────────────────────
    //
    // decks.meta is ONE JSONB column shared by six unrelated features, and
    // pushDeckRowsToCloud sends it whole — so a device that pushed without
    // having pulled overwrote every key in it. The highlights were merged and
    // nothing else was, which is why the worst case is a paper attached on one
    // device disappearing on the next push from another: the annotations
    // survive and the document they are coordinates INTO does not.
    must("a paper attached on the other device survives this one's push", () => {
      const cloud = { notes: "", meta: { pdf: { name: "paper.pdf", sha256: "abc", pages: 12 } } };
      const mine = { notes: "", meta: {} };
      const r = docSync.reconcileDeckBeforePush(mine, cloud);
      return r?.meta?.pdf?.sha256 === "abc" || `meta.pdf is ${JSON.stringify(r?.meta?.pdf)}`;
    });
    must("...and so do a bookmark, a link id, a category and an anchor", () => {
      const cloud = {
        notes: "",
        meta: {
          bookmark: { offset: 4, at: 200 },
          linkIds: ["ld_laptop"],
          quickNoteCategories: [{ id: "qc_1", name: "Optics", color: "#fff" }],
          noteAnchors: { c1: { text: "somewhere" } }
        }
      };
      const mine = { notes: "", meta: { linkIds: ["ld_phone"] } };
      const r = docSync.reconcileDeckBeforePush(mine, cloud);
      const lost = [];
      if (r?.meta?.bookmark?.at !== 200) lost.push("bookmark");
      if ((r?.meta?.linkIds || []).join(",") !== "ld_laptop,ld_phone") lost.push("linkIds");
      if ((r?.meta?.quickNoteCategories || []).length !== 1) lost.push("quickNoteCategories");
      if (!r?.meta?.noteAnchors?.c1) lost.push("noteAnchors");
      return !lost.length || `clobbered: ${lost.join(", ")}`;
    });
    must("...and the reader's place is settled by its own stamp, not by who pushed", () => {
      const cloud = { notes: "", meta: { readingPosition: { offset: 900, at: 300 } } };
      const mine = { notes: "", meta: { readingPosition: { offset: 10, at: 100 } } };
      const r = docSync.reconcileDeckBeforePush(mine, cloud);
      // The cloud's is newer by `at`, so it wins even though this device is the
      // one doing the pushing. The reverse pair has to go the other way.
      const back = docSync.reconcileDeckBeforePush(
        { notes: "", meta: { readingPosition: { offset: 10, at: 400 } } }, cloud);
      return (r?.meta?.readingPosition?.offset === 900 && back?.meta?.readingPosition?.offset === 10)
        || `kept ${r?.meta?.readingPosition?.offset} then ${back?.meta?.readingPosition?.offset}`;
    });
    // ── A bookmark on a paper is the same key, a different shape ──────────
    //
    // The bookmark stopped being notes-only when the sync took over saving it:
    // on the Document view it carries { pdfPage, ratio } instead of a character
    // offset (see buildBookmarkAnchor in src/notes/bookmark.js). Nothing in the
    // merge had to change for that, and this is the case that says so — the
    // rule above compares `.at` and never looks inside the anchor, so a page on
    // one device and an offset on another are settled by when the reader was
    // there, exactly as two offsets are.
    must("...including one that names a page rather than a character", () => {
      const cloud = { notes: "", meta: { bookmark: { offset: 3, pdfPage: 3, ratio: 0.25, text: "Page 3", at: 200 } } };
      const mine = { notes: "", meta: {} };
      const r = docSync.reconcileDeckBeforePush(mine, cloud);
      const kept = r?.meta?.bookmark;
      if (kept?.pdfPage !== 3) return `pdfPage is ${kept?.pdfPage}`;
      if (kept?.ratio !== 0.25) return `ratio is ${kept?.ratio}`;
      return true;
    });
    must("...and a newer page beats an older offset, and the other way round", () => {
      // The two devices are reading the same deck on different surfaces — one
      // has the paper open, one the notes. Whoever was there LAST wins, which
      // is the only rule either shape has ever been settled by.
      const cloudNotes = { bookmark: { offset: 4200, source: "a line", at: 100 } };
      const minePage = { notes: "", meta: { bookmark: { offset: 7, pdfPage: 7, ratio: 0.5, at: 900 } } };
      const newer = docSync.reconcileDeckBeforePush(minePage, { notes: "", meta: cloudNotes });
      if (newer?.meta?.bookmark?.pdfPage !== 7) return `the newer page lost: ${JSON.stringify(newer?.meta?.bookmark)}`;
      const cloudPage = { bookmark: { offset: 7, pdfPage: 7, ratio: 0.5, at: 900 } };
      const mineOlder = { notes: "", meta: { bookmark: { offset: 4200, source: "a line", at: 100 } } };
      const older = docSync.reconcileDeckBeforePush(mineOlder, { notes: "", meta: cloudPage });
      if (older?.meta?.bookmark?.pdfPage !== 7) return `the newer page lost on the other side: ${JSON.stringify(older?.meta?.bookmark)}`;
      // ...and the pull, where the preference is the other way, must agree.
      const pulled = docSync.mergeDeckMeta(cloudPage, { bookmark: { offset: 4200, at: 100 } }, { prefer: "cloud" });
      return pulled.bookmark?.pdfPage === 7 || `the pull kept ${JSON.stringify(pulled.bookmark)}`;
    });
    // A deck can carry two documents now (src/documents/doc-slot.js), and the
    // second one has to be as undeletable as the first. A device that has not
    // opened the Write tab since the notebook moved out of meta.pdf sends a meta
    // with no `notebook` key at all — and an absent key must never take a paper
    // full of somebody's handwriting off the other device.
    must("a notebook the other side has never heard of is not deleted by it", () => {
      const notebook = { name: "handwritten-notes.pdf", pages: 4, paper: "grid", notebook: true };
      const up = docSync.mergeDeckMeta({}, { notebook }, { prefer: "local" });
      if (up.notebook?.pages !== 4) return `the push lost it: ${JSON.stringify(up.notebook)}`;
      const down = docSync.mergeDeckMeta({}, { notebook }, { prefer: "cloud" });
      if (down.notebook?.pages !== 4) return `the pull lost it: ${JSON.stringify(down.notebook)}`;
      // ...and the two documents do not displace each other.
      const both = docSync.mergeDeckMeta(
        { pdf: { name: "preprint.pdf", sha256: "aaa" } }, { notebook }, { prefer: "local" });
      return (both.pdf?.sha256 === "aaa" && both.notebook?.pages === 4)
        || `a deck with both kept ${JSON.stringify({ pdf: both.pdf, notebook: both.notebook })}`;
    });

    // The strokes and blocks of both documents share one array each, told apart
    // by a `doc` field. The merge is by id and knows nothing about the field,
    // which is the whole reason a second array was not worth having — so what
    // this asks is that the field SURVIVES a round trip through it.
    must("...and each mark still says which of the two papers it is on", () => {
      const merged = docSync.mergeDocumentAnnotations({
        cloudNotes: "",
        cloudMeta: { pdfHighlights: [{ id: "hn-cloud", page: 1, kind: "ink", doc: "notebook", at: 200 }] },
        localNotes: "",
        localMeta: { pdfHighlights: [{ id: "hn-local", page: 1, kind: "text", at: 100 }] },
        body: "local"
      });
      const byId = new Map((merged.pdfHighlights || []).map((record) => [record.id, record]));
      if (byId.size !== 2) return `${byId.size} record(s) after the merge`;
      if (byId.get("hn-cloud")?.doc !== "notebook") return "the notebook's mark lost the paper it was on";
      if ("doc" in (byId.get("hn-local") || {})) return "the deck's own mark was given a paper it is not on";
      return true;
    });

    must("...while a key only this device knows about still goes up", () => {
      const r = docSync.reconcileDeckBeforePush(
        { notes: "", meta: { pdf: { name: "mine.pdf", sha256: "zzz" } } }, { notes: "", meta: {} });
      return r?.meta?.pdf?.sha256 === "zzz" || `meta.pdf is ${JSON.stringify(r?.meta?.pdf)}`;
    });
    must("...and the pull is the same story with the sides swapped", () => {
      // The pull's meta was `{ ...cloudMeta }` with linkIds unioned back on, so a
      // bookmark set on this device while offline, or a paper attached here and
      // not yet pushed, was destroyed by the next pull exactly as the push
      // destroyed the other device's. Same rules, preference the other way.
      const merged = docSync.mergeDeckMeta(
        { bookmark: { offset: 4, at: 100 }, quickNoteCategories: [{ id: "qc_1", name: "Theirs" }] },
        { pdf: { name: "mine.pdf" }, bookmark: { offset: 9, at: 500 }, quickNoteCategories: [{ id: "qc_2", name: "Mine" }] },
        { prefer: "cloud" });
      const lost = [];
      if (!merged.pdf) lost.push("pdf");
      // Newer by its own stamp, and this device's — the cloud being the side we
      // are pulling from does not make it right about when the reader was there.
      if (merged.bookmark?.offset !== 9) lost.push("bookmark");
      if ((merged.quickNoteCategories || []).length !== 2) lost.push("quickNoteCategories");
      return !lost.length || `lost on the pull: ${lost.join(", ")}`;
    });
    must("...and identical meta in a different key order is not a change", () => {
      // `changed` is what decides whether every deck's snapshot gets rewritten on
      // every sync, and the merge rebuilds the bag by spreading — so comparing it
      // with a plain JSON.stringify compares the KEY ORDER too. The two sides come
      // from different places (a JSONB column off the network, a snapshot out of
      // IndexedDB), so identical content in a different order is the ordinary
      // case. Getting this wrong is pure quota churn on the device with the least
      // of it.
      const r = docSync.reconcileDeckBeforePush(
        { notes: "# plain", meta: { linkIds: ["a"], readingPosition: { at: 1, offset: 2 } } },
        { notes: "# plain", meta: { readingPosition: { offset: 2, at: 1 }, linkIds: ["a"] } });
      return r?.changed === false || `changed=${r?.changed}, meta ${JSON.stringify(r?.meta)}`;
    });
    must("...and a row with no notes column is still refused outright", () => {
      // The slim index row. Merging against a column it has never seen would
      // delete that column; the caller must skip the deck rather than push.
      const r = docSync.reconcileDeckBeforePush({ notes: "x", meta: {} }, { meta: {} });
      return r === null || `merged against a row with no body: ${JSON.stringify(r)}`;
    });

    // ── 9c. Clearing a note has to stick ────────────────────────────────
    //
    // An empty side used to mean "adopt the other side's text" unconditionally,
    // which is right when this device has never seen the note and wrong when it
    // deleted it — and a note you cleared came back on every sync for ever.
    must("a note cleared here is not restored by the cloud's copy", () => {
      const id = "hn-ddd444";
      const theirs = withNotes("body", [{ id, label: "“x”", text: "the old note" }]);
      const out = docSync.mergeDocumentAnnotations({
        cloudNotes: theirs,
        cloudMeta: { pdfHighlights: [{ id, at: 1, noteAt: 100 }] },
        localNotes: "body",
        localMeta: { pdfHighlights: [{ id, at: 1, noteAt: 200 }] },
        body: "local"
      });
      const kept = merge.parseHighlightNoteEntries(out.notes).find((e) => e.id === id);
      return !kept || `restored ${JSON.stringify(kept.text)}`;
    });
    must("...but one this device has never seen is still adopted", () => {
      const id = "hn-eee555";
      const theirs = withNotes("body", [{ id, label: "“x”", text: "written there" }]);
      const out = docSync.mergeDocumentAnnotations({
        cloudNotes: theirs,
        cloudMeta: { pdfHighlights: [{ id, at: 1, noteAt: 100 }] },
        localNotes: "body",
        // No noteAt at all — this device made the highlight and never wrote on
        // it, which reads as older than one that has a stamp.
        localMeta: { pdfHighlights: [{ id, at: 1 }] },
        body: "local"
      });
      const kept = merge.parseHighlightNoteEntries(out.notes).find((e) => e.id === id);
      return kept?.text === "written there" || `adopted ${JSON.stringify(kept?.text)}`;
    });
    must("...and a note written after the clear wins over the clear", () => {
      const id = "hn-fff666";
      const theirs = withNotes("body", [{ id, label: "“x”", text: "written after" }]);
      const out = docSync.mergeDocumentAnnotations({
        cloudNotes: theirs,
        cloudMeta: { pdfHighlights: [{ id, at: 1, noteAt: 300 }] },
        localNotes: "body",
        localMeta: { pdfHighlights: [{ id, at: 1, noteAt: 200 }] },
        body: "local"
      });
      const kept = merge.parseHighlightNoteEntries(out.notes).find((e) => e.id === id);
      return kept?.text === "written after" || `kept ${JSON.stringify(kept?.text)}`;
    });

    must("a <mark> note with no record anywhere keeps both texts", () => {
      const mine = withNotes("body", [{ id: "hn-ccc333", label: "“x”", text: "typed here" }]);
      const theirs = withNotes("body", [{ id: "hn-ccc333", label: "“x”", text: "typed there" }]);
      const out = docSync.mergeDocumentAnnotations({ cloudNotes: theirs, localNotes: mine, body: "cloud" });
      const text = merge.parseHighlightNoteEntries(out.notes)[0].text;
      return (text.includes("typed here") && text.includes("typed there")) || `kept only ${JSON.stringify(text)}`;
    });
  }

  // ── ...and does the deck they live on ever get SAVED? ───────────────────
  //
  // A paper's annotations are the one deck shape that is empty by every other
  // measure: no cards, and a body that is empty because the PDF is the
  // document. saveDeckToLibrary knows that (deckPayloadHasContent answers true
  // for meta.pdf) and the autosave timer asks it — but the flush that runs on
  // NAVIGATION restated the predicate as `!masterCards.length &&
  // !notes.trim()`, which is true of every PDF deck. So it cleared the armed
  // timer, returned without saving, and the highlights of the last 400ms went
  // with the deck being left. That is a merge that never gets the chance to
  // happen, which is why it is asserted here.
  //
  // Two questions, because passing one is not passing the other: does the
  // shared predicate still recognise a paper, and is the flush still asking it
  // rather than spelling it out again?
  {
    const snapshotSrc = readFileSync(path.join(ROOT, "src/storage/deck-snapshot.js"), "utf8");
    const hasContent = new Function(
      `${snapshotSrc.match(/export function deckPayloadHasContent[\s\S]*?\n}/)[0].replace(/^export /, "")}
       return deckPayloadHasContent;`
    )();

    must("a PDF deck with no cards and no body still counts as content", () =>
      hasContent({ cards: [], notes: "", meta: { pdf: { name: "paper.pdf" } } }) === true
      || "deckPayloadHasContent called a paper empty");

    must("a deck with nothing at all still counts as empty", () =>
      hasContent({ cards: [], notes: "   ", meta: {} }) === false
      || "deckPayloadHasContent called an empty deck full");

    // The predicate gates the LOAD as well as the save, so a notebook written by
    // the build before Handwritten Notes moved onto real paper has to pass it or
    // it reports itself corrupted with every stroke intact in the file. It has no
    // cards, no note and no document — `meta.pages` is the only thing in it.
    must("an older notebook, whose pages are all it has, still counts as content", () =>
      hasContent({ cards: [], notes: "", meta: { pages: [{ id: "hp-1", ink: [] }] } }) === true
      || "deckPayloadHasContent called a legacy notebook empty — it would refuse to load");

    must("...but an empty page list does not make an empty deck full", () =>
      hasContent({ cards: [], notes: "", meta: { pages: [] } }) === false
      || "deckPayloadHasContent counted a zero-page notebook as content");

    const storeSrc = readFileSync(path.join(ROOT, "src/storage/deck-store.js"), "utf8");
    // Comments stripped: the entry in tools/split-parity.mjs and the comment in
    // the function itself both NAME the predicate that was there, and a check
    // that fails on its own explanation is a check nobody keeps.
    const flush = storeSrc.match(/export async function flushPendingDeckAutosave[\s\S]*?\n}/)[0]
      .replace(/^[^\S\n]*\/\/.*$/gm, "");
    must("the navigation flush asks the shared predicate", () =>
      /deckHasNothingToSave\(\)/.test(flush)
      || "flushPendingDeckAutosave does not call deckHasNothingToSave()");
    must("...and does not spell out a second one", () =>
      !/masterCards\.length|notes\.trim\(\)/.test(flush)
      || "flushPendingDeckAutosave restates the save predicate — the two will drift again");
  }

  console.log("── document sync ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
