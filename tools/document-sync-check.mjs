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
    const reconciled = docSync.reconcileDocumentBeforePush(snapshot, cloud);
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
    must("a deck with no annotations grows no keys and needs no reconcile", () => {
      const pulled = pull(a, cloud);
      const pushed = push(a, cloud);
      return (pulled.pdfHighlights === null && pushed === null
        && !("pdfHighlights" in a.meta) && !("deletedHighlightIds" in a.meta))
        || `meta: ${JSON.stringify(a.meta)}, push: ${JSON.stringify(pushed)}`;
    });

    must("a <mark> note with no record anywhere keeps both texts", () => {
      const mine = withNotes("body", [{ id: "hn-ccc333", label: "“x”", text: "typed here" }]);
      const theirs = withNotes("body", [{ id: "hn-ccc333", label: "“x”", text: "typed there" }]);
      const out = docSync.mergeDocumentAnnotations({ cloudNotes: theirs, localNotes: mine, body: "cloud" });
      const text = merge.parseHighlightNoteEntries(out.notes)[0].text;
      return (text.includes("typed here") && text.includes("typed there")) || `kept only ${JSON.stringify(text)}`;
    });
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
