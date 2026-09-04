// Is the thing you pressed Backup for actually in the file?
//
//   node tools/backup-check.mjs
//
// Nothing asked. Thirty-seven checks in tools/check.mjs and not one of them drove
// a backup through to a restore, so every feature the app grew after the archive
// was written — papers, highlights, the notes written on highlights, folders,
// quick notes, reading positions — reached it late, partially, or not at all,
// and the way you found out was needing the backup. That is the failure this
// file exists for, and the COVERAGE cases below are the half that keeps it
// fixed: a new key in a deck's meta bag, or a new IndexedDB store, fails here
// until someone says out loud whether a backup carries it.
//
// ── Why plain Node ──────────────────────────────────────────────────────────
//
// tools/sync-parity.mjs holds the only backup coverage there was, and it needs
// Chrome AND `git archive pre-modular`, a tag not every clone carries — so on
// most machines it exits 0 having verified nothing. A check that can skip is a
// check that catches nothing, which is exactly how this area got where it is.
//
// So: no browser, no network, no baseline. The one thing that genuinely was not
// available is a zip library — JSZip is a CDN script (src/core/lib-loader.js),
// not a vendored one. It is not stubbed here. src/backup/zip-lite.js is the
// app's own stored-zip reader and writer, shipped for the case where that CDN
// fetch fails, and `backupZipFactory` hands it out whenever JSZip is absent —
// which, in Node, it genuinely is. So this drives the real backup and the real
// restore over the real fallback, and case 0 asserts the two implementations
// are interchangeable by checking that src/backup/*.js never reaches for a
// member of JSZip that zip-lite does not have.

// ── One thing to know before adding a case ─────────────────────────────────
//
// Section B and C are a SEQUENCE. They share one restored library and each case
// damages it a little further — half the highlights gone, then a tombstoned one,
// then the bookmark — because that is what a partial loss actually looks like
// and building a fresh device for each would test a device nobody has. A case
// inserted into the middle of that run must not call resetWorld(); the sections
// that begin with one (D onwards) are where an independent case belongs.

import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = mkdtempSync(path.join(tmpdir(), "recall-backup-"));

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

// Several cases below deliberately provoke a failure the app is supposed to
// survive — a damaged archive, a deck the store refuses — and the app correctly
// warns about each one. Those warnings are the code working, not a problem, but
// they go to stderr, where they bury this file's own report and leave
// tools/check.mjs quoting a stack frame as the summary. So they are collected
// and counted rather than printed; `--verbose` prints them, and the count is
// always reported so nothing is silently swallowed.
const VERBOSE = process.argv.includes("--verbose");
const appWarnings = [];
const realWarn = console.warn;
const realError = console.error;
console.warn = (...args) => { appWarnings.push(args.map(String).join(" ")); if (VERBOSE) realWarn(...args); };
console.error = (...args) => { appWarnings.push(args.map(String).join(" ")); if (VERBOSE) realError(...args); };

const results = [];
let failures = 0;
async function must(name, fn) {
  let detail;
  try {
    detail = await fn();
  } catch (error) {
    detail = `threw: ${error?.message || error}`;
  }
  const ok = detail === true;
  results.push([ok, name, ok ? "" : String(detail)]);
  if (!ok) failures += 1;
}

// Every .js under src/, as text. The coverage cases are static scans and this is
// what they scan.
function allSources(dir = path.join(ROOT, "src"), out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) allSources(full, out);
    else if (entry.endsWith(".js")) out.push([path.relative(ROOT, full), readFileSync(full, "utf8")]);
  }
  return out;
}

// One realistic value per key the coverage table claims the archive carries.
// The round-trip case below generates one deck per key from this, so a key
// added to the table with no fixture fails rather than passing vacuously.
const META_FIXTURES = {
  pdf: { name: "paper.pdf", pages: 3, sha256: "", path: "u1/pdfs/paper--a1/paper.pdf" },
  pdfHighlights: [{ id: "hn-h1", page: 1, quads: [[1, 2, 3, 4]], color: "yellow", at: 1_800_000_000_000 }],
  deletedHighlightIds: { "hn-hz": "2027-01-01T00:00:00.000Z" },
  pdfToc: [{ title: "Intro", page: 1 }],
  bookmark: { offset: 10, text: "here", at: 1_800_000_000_000 },
  readingPosition: { offset: 20, text: "there", at: 1_800_000_000_000 },
  linkIds: ["lnk-one"],
  quickNoteCategories: [{ id: "q1", name: "Ideas", color: "#ff0" }],
  noteAnchors: { x: { offset: 3 } },
  pdfBlocks: [{ id: "bk-b1", page: 2, x: 40, y: 700, w: 240, h: 90, z: 0, md: "**why** it matters", at: 1_800_000_000_000 }],
  deletedBlockIds: { "bk-bz": "2027-01-01T00:00:00.000Z" }
};

try {
  cpSync(path.join(ROOT, "src"), path.join(stage, "src"), { recursive: true });
  destamp(path.join(stage, "src"));

  // ── The smallest possible browser ────────────────────────────────────────
  //
  // Same approach and the same warning as tools/document-sync-check.mjs: the
  // modules under test touch very little of this, their IMPORTS touch a lot of
  // it, and a stub that is genuinely load-bearing would make this a check of its
  // own scaffolding. So the DOM here answers everything and asserts nothing —
  // the assertions below are all about bytes in an archive and rows in a store.
  //
  // The one stub that MATTERS is `document.head.appendChild`, which fails the
  // script load immediately. That is not a convenience: it is the check running
  // in the state a user is in when the CDN is blocked, which is the state the
  // zip fallback exists for.
  // A DOM element, real enough to be written to and read back. It has to be a
  // plain object rather than a catch-all proxy for one specific reason: the
  // script-loading path assigns `script.onerror` and the appendChild below calls
  // it, so a proxy that swallowed the assignment would hang the load forever
  // instead of failing it.
  const makeElement = (tag = "div") => {
    const element = {
      tagName: String(tag).toUpperCase(),
      textContent: "", innerHTML: "", value: "", className: "", id: "", href: "", download: "",
      hidden: false, disabled: false, checked: false, src: "", async: false,
      onload: null, onerror: null,
      style: {}, dataset: {}, children: [], files: [],
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
      appendChild: (child) => child, append() {}, prepend() {}, insertBefore: (child) => child,
      remove() {}, click() {}, focus() {}, blur() {}, scrollTo() {}, insertAdjacentHTML() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
      querySelector: () => makeElement(), querySelectorAll: () => [], closest: () => null,
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 })
    };
    return element;
  };
  globalThis.document = {
    // Every query answers with an element. src/core/dom.js runs a hundred of
    // these at module scope and the whole app reads `el.something.textContent`
    // without checking — answering null would make this a check of how the app
    // behaves in a browser that does not exist.
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getElementById: () => makeElement(),
    createElement: (tag) => makeElement(tag),
    createTextNode: () => makeElement("#text"),
    createDocumentFragment: () => makeElement(),
    addEventListener() {}, removeEventListener() {},
    documentElement: makeElement("html"),
    body: makeElement("body"),
    // The one stub that is load-bearing, and deliberately so: a script appended
    // here fails immediately, which is precisely the state a blocked CDN puts a
    // user in — and the state src/backup/zip-lite.js exists for.
    head: { appendChild: (script) => { script.onerror?.(); return script; } }
  };
  const store = new Map();
  globalThis.localStorage = new Proxy({
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() { return store.size; }
  }, {
    // Object.keys(localStorage) is how deck-store enumerates its fallback rows.
    ownKeys: (target) => [...Object.keys(target), ...store.keys()],
    getOwnPropertyDescriptor: (target, key) => (store.has(key)
      ? { value: store.get(key), enumerable: true, configurable: true }
      : Object.getOwnPropertyDescriptor(target, key)),
    get: (target, key) => (typeof key === "string" && store.has(key) && !(key in target) ? store.get(key) : target[key])
  });

  // ── IndexedDB, enough of it ──────────────────────────────────────────────
  //
  // Three real stores ride on this — deck snapshots, the PDFs, and the image
  // outbox — and the whole point of the papers half of this check is that they
  // are keyed by a local id the restore has to get right. Faking that away
  // would fake away the bug.
  const databases = new Map();
  const settle = (request, run) => {
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
      }
    });
    return request;
  };
  globalThis.indexedDB = {
    open(name) {
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
      queueMicrotask(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name);
        const db = {
          objectStoreNames: { contains: (store) => stores.has(store) },
          createObjectStore: (store, { keyPath }) => {
            stores.set(store, { keyPath, rows: new Map() });
            return {};
          },
          transaction(store) {
            const tx = { oncomplete: null, onerror: null, onabort: null };
            const table = stores.get(store);
            queueMicrotask(() => tx.oncomplete?.());
            tx.objectStore = () => ({
              put: (row) => settle({}, () => { table.rows.set(String(row[table.keyPath]), row); return undefined; }),
              get: (key) => settle({}, () => table.rows.get(String(key))),
              delete: (key) => settle({}, () => { table.rows.delete(String(key)); return undefined; }),
              getAll: () => settle({}, () => [...table.rows.values()]),
              count: () => settle({}, () => table.rows.size),
              clear: () => settle({}, () => { table.rows.clear(); return undefined; }),
              openCursor: () => {
                const rows = [...table.rows.values()];
                const request = { onsuccess: null, onerror: null, result: null };
                let at = 0;
                const step = () => queueMicrotask(() => {
                  request.result = at < rows.length
                    ? { value: rows[at++], continue: step }
                    : null;
                  request.onsuccess?.({ target: request });
                });
                step();
                return request;
              }
            });
            return tx;
          },
          close() {}
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.({ target: request });
        request.onsuccess?.({ target: request });
      });
      return request;
    }
  };

  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.BroadcastChannel = class { postMessage() {} close() {} addEventListener() {} };
  // Node 22 defines navigator as a getter-only global, so it is redefined
  // rather than assigned. `onLine: false` is deliberate — see fetch below.
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: false, storage: { estimate: async () => ({ usage: 0, quota: 0 }) } },
    configurable: true, writable: true
  });
  // No image reaches the network here, and a check that quietly did would be a
  // check with a different result on a train.
  globalThis.fetch = async () => { throw new Error("offline"); };
  globalThis.JSZip = undefined;

  // downloadBlob's first act is URL.createObjectURL, so this is where the
  // finished archive is caught — no click, no anchor, no filesystem.
  let lastDownload = null;
  globalThis.URL.createObjectURL = (blob) => { lastDownload = blob; return "blob:archive"; };
  globalThis.URL.revokeObjectURL = () => {};

  const load = (rel) => import(path.join(stage, rel));

  const archiveFormat = await load("src/backup/archive-format.js");
  const zipLite = await load("src/backup/zip-lite.js");
  const backup = await load("src/backup/backup.js");
  const restore = await load("src/backup/restore.js");
  const documents = await load("src/backup/documents.js");
  const libraryState = await load("src/backup/library-state.js");
  const history = await load("src/backup/history.js");
  const deckStore = await load("src/storage/deck-store.js");
  const pdfStore = await load("src/documents/pdf-store.js");
  const folders = await load("src/library/folders.js");
  const localLibrary = await load("src/library/local-library.js");
  const readingPosition = await load("src/notes/reading-position.js");
  const keys = await load("src/storage/keys.js");

  const sources = allSources();

  // ── A library to back up ────────────────────────────────────────────────

  const T0 = 1_800_000_000_000;
  const iso = (ms) => new Date(ms).toISOString();
  const pdfBytes = (seed) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, seed, seed ^ 0xff, 0, 255]);

  // A fresh device, without reopening anything.
  //
  // The stores cache their open database in a module-level `let`, and an ES
  // module binding cannot be reassigned from outside — so the tables are emptied
  // IN PLACE rather than dropped and rebuilt. Same Maps, no rows: the cached
  // handle stays valid and sees an empty store, which is what a cleared profile
  // looks like from inside the app.
  function resetWorld() {
    store.clear();
    for (const tables of databases.values()) {
      for (const table of tables.values()) table.rows.clear();
    }
    deckStore.deckSnapshotCache.clear();
    deckStore.pendingDeckWrites.clear();
    lastDownload = null;
  }

  async function seedDeck({ localId, deckId = null, title, category = "", notes = "", meta = {}, cards = [], updatedAt = T0, pdf = null }) {
    const snapshot = {
      app: "recall", version: 1, exportedAt: iso(updatedAt),
      deckTitle: title, deckCategory: category, notes,
      deckId, current: 0, localDeckId: localId, meta,
      cards: cards.map((card, i) => ({ id: card.id || `c${i}`, question: card.question, answer: card.answer || "", status: card.status || null, category: null }))
    };
    deckStore.writeDeckSnapshot(localId, snapshot);
    await deckStore.deckWriteSettled(localId);
    const index = localLibrary.readLocalDeckIndex();
    localLibrary.writeLocalDeckIndex([...index, {
      id: localId, title, category: category || "Uncategorized",
      cardCount: cards.length, hasNotes: Boolean(notes.trim()),
      updatedAt: iso(updatedAt), createdAt: iso(updatedAt), deckId, lastSyncedAt: null, accessedAt: null
    }]);
    if (pdf) await pdfStore.putDocument({ deckLocalId: localId, blob: new Blob([pdf], { type: "application/pdf" }), sha256: meta.pdf?.sha256 || "", name: meta.pdf?.name || "paper.pdf", at: updatedAt });
    return snapshot;
  }

  async function takeBackup(options = {}) {
    lastDownload = null;
    const ok = await backup.runLibraryBackup({ includeImages: true, includeDocuments: true, progress: null, ...options });
    if (!ok) throw new Error("runLibraryBackup returned false");
    if (!lastDownload) throw new Error("no archive was produced");
    return new Uint8Array(await lastDownload.arrayBuffer());
  }

  function archiveFile(bytes, name = "recall-backup.zip") {
    // Everything readBackupArchive asks of the value it is handed.
    return { name, type: "application/zip", size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
  }

  async function openArchive(bytes) {
    return zipLite.LiteZip.loadAsync(bytes);
  }

  async function readEntry(bytes, name) {
    const zip = await openArchive(bytes);
    const key = archiveFormat.findArchiveFile(Object.keys(zip.files), name);
    return key ? zip.files[key].async("string") : null;
  }

  // Rebuild an archive with some entries dropped or damaged, so verification has
  // something real to catch. Written through the same zip-lite the app writes
  // with, so what is produced is a genuine zip and not a fixture shaped to pass.
  async function rewriteArchive(bytes, transform) {
    const zip = await openArchive(bytes);
    const out = new zipLite.LiteZip();
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      const replacement = await transform(name, zip.files[name]);
      if (replacement === null) continue;
      out.file(name, replacement === undefined ? await zip.files[name].async("uint8array") : replacement);
    }
    return out.generateAsync({ type: "uint8array" });
  }

  async function restoreArchive(bytes, { confirm = true } = {}) {
    const archive = await restore.readBackupArchive(archiveFile(bytes));
    const assetPlan = await restore.planBackupAssetAdoption(archive.decks, archive.assets);
    restore.applyBackupAssetRewrites(archive.decks, assetPlan.rewrites);
    const report = await restore.planRestore(archive.decks);
    report.assetPlan = assetPlan;
    report.zip = archive.zip;
    report.manifest = archive.manifest;
    report.verification = archive.verification;
    report.documentIndex = archive.documentIndex;
    report.libraryState = archive.libraryState;
    if (confirm) await restore.applyRestore(report, { autoBackup: false });
    return report;
  }

  // ── 0. The zip surface is contained ─────────────────────────────────────
  //
  // Everything below drives the real backup and restore over src/backup/zip-lite.js,
  // because JSZip is not available in Node. That is only a fair test of the
  // JSZip path if the two are interchangeable — so: every member the backup code
  // reaches for on a zip must be one zip-lite implements. Reach for
  // `generateInternalStream` or `zip.folder()` and this goes red, which is the
  // signal to teach zip-lite about it rather than to quietly stop testing the
  // round trip.
  const ZIP_SURFACE = new Set(["file", "files", "async", "dir", "loadAsync", "generateAsync", "name"]);
  await must("the backup uses no zip member the fallback lacks", () => {
    const used = new Set();
    for (const [rel, text] of sources) {
      if (!rel.startsWith("src/backup/") || rel.endsWith("zip-lite.js")) continue;
      for (const match of text.matchAll(/\b(?:zip|Zip|JSZip)\.([A-Za-z_$][\w$]*)/g)) used.add(match[1]);
      for (const match of text.matchAll(/zip\.files\[[^\]]+\]\??\.([A-Za-z_$][\w$]*)/g)) used.add(match[1]);
    }
    const extra = [...used].filter((member) => !ZIP_SURFACE.has(member));
    return extra.length === 0 || `src/backup/* uses zip members zip-lite does not implement: ${extra.join(", ")}`;
  });

  // ── A. Round trip: the archive is the library ───────────────────────────

  resetWorld();
  const paperMeta = {
    pdf: { name: "mitosis.pdf", pages: 14, sha256: "", path: "u1/pdfs/mitosis--k3/paper.pdf" },
    // Real `hn-` ids: the fenced block that holds the notes written ON these
    // highlights keys its entries by them, and an id the parser does not accept
    // would make the notes-merge case below pass by never running.
    pdfHighlights: Array.from({ length: 6 }, (_, i) => ({ id: `hn-h${i}`, page: i + 1, quads: [[i, i, i + 1, i + 1]], color: "yellow", at: T0 + i, noteAt: T0 + i })),
    pdfToc: [{ title: "Introduction", page: 1 }],
    bookmark: { offset: 120, text: "spindle", at: T0 + 5000 },
    linkIds: ["lnk-a"],
    noteAnchors: { c0: { offset: 4 } },
    readingPosition: { offset: 240, text: "anaphase", at: T0 + 6000 }
  };
  await seedDeck({
    localId: "ld_paper", deckId: "cloud-paper", title: "Mitosis", category: "Science/Cell Biology",
    notes: "Reading notes.\n\n<!--recall:highlight-notes-->\n<!--hn:hn-h0 page 1-->\nthe spindle forms here\n<!--hn:hn-h3 page 4-->\ncheck this figure\n<!--/recall:highlight-notes-->\n",
    meta: paperMeta, cards: [{ id: "c0", question: "What is anaphase?", answer: "Separation" }],
    updatedAt: T0, pdf: pdfBytes(7)
  });
  await seedDeck({ localId: "ld_prose", deckId: null, title: "Reading list", category: "", notes: "# Books\n\n- one\n", cards: [], updatedAt: T0 });
  await seedDeck({ localId: "ld_deep", deckId: "cloud-deep", title: "Derivatives", category: "Math/Calculus/Rules", notes: "chain rule", cards: [{ id: "d0", question: "d/dx x^2", answer: "2x" }], updatedAt: T0 });
  folders.addKnownFolder("Papers/Unread");
  readingPosition.writeStoredReadingPosition(JSON.stringify(["cloud-paper", "ld_paper", null]), { offset: 900, text: "telophase", at: T0 + 9000 });

  const archiveBytes = await takeBackup();

  await must("the archive holds one file per deck, in its own folder path", async () => {
    const zip = await openArchive(archiveBytes);
    const names = Object.keys(zip.files);
    const wanted = ["decks/Science/Cell Biology/", "decks/Math/Calculus/Rules/"];
    const missing = wanted.filter((prefix) => !names.some((name) => name.startsWith(prefix) && name.endsWith(".json")));
    return missing.length === 0 || `no deck file under ${missing.join(", ")} — got ${names.filter((n) => n.startsWith("decks/")).join(", ")}`;
  });

  await must("the manifest declares the archive it was written beside", async () => {
    const manifest = JSON.parse(await readEntry(archiveBytes, "manifest.json"));
    if (manifest.schema !== archiveFormat.BACKUP_SCHEMA) return `schema is ${manifest.schema}`;
    if (manifest.version !== archiveFormat.BACKUP_VERSION) return `version is ${manifest.version}`;
    if (manifest.deckCount !== 3) return `deckCount is ${manifest.deckCount}`;
    if (manifest.documentCount !== 1) return `documentCount is ${manifest.documentCount}`;
    if (!Array.isArray(manifest.contents) || !manifest.contents.length) return "no contents inventory";
    if (!manifest.decks.some((deck) => deck.localId === "ld_paper")) return "the manifest does not record the source local ids";
    return true;
  });

  await must("a paper's bytes are in the archive, not just its name", async () => {
    const zip = await openArchive(archiveBytes);
    const pdfs = Object.keys(zip.files).filter((name) => name.startsWith("documents/") && name.endsWith(".pdf"));
    if (pdfs.length !== 1) return `expected one packed PDF, found ${pdfs.length}`;
    const bytes = await zip.files[pdfs[0]].async("uint8array");
    return String(bytes) === String(pdfBytes(7)) || "the packed PDF is not the file that was imported";
  });

  await must("the document index binds each paper to its deck file", async () => {
    const index = JSON.parse(await readEntry(archiveBytes, "documents/index.json"));
    const entry = index.documents[0];
    if (!entry) return "no document entry";
    if (!entry.deckFile?.startsWith("decks/Science/Cell Biology/")) return `deckFile is ${entry.deckFile}`;
    if (entry.deckLocalId !== "ld_paper") return `deckLocalId is ${entry.deckLocalId}`;
    return Boolean(entry.sha256) || "the archive does not record the packed file's own hash";
  });

  await must("an empty folder and a reading position ride along", async () => {
    const library = JSON.parse(await readEntry(archiveBytes, "library.json"));
    if (!library.folders.known.includes("Papers/Unread")) return `known folders are ${JSON.stringify(library.folders.known)}`;
    const position = library.readingPositions.find((entry) => entry.localDeckId === "ld_paper");
    return Boolean(position && position.anchor.offset === 900) || "the reading position was not carried";
  });

  // ── B. Restoring onto an empty device ───────────────────────────────────

  resetWorld();
  await restoreArchive(archiveBytes);

  await must("every deck comes back, in its own folder", () => {
    const index = localLibrary.readLocalDeckIndex();
    if (index.length !== 3) return `${index.length} decks restored`;
    const paper = index.find((deck) => deck.title === "Mitosis");
    return paper?.category === "Science/Cell Biology" || `the paper landed in ${paper?.category}`;
  });

  await must("...and the paper's own bytes come back with it", async () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const row = await pdfStore.readDocument(paper.id);
    if (!row?.blob) return "the restored paper has no document on this device";
    const bytes = new Uint8Array(await row.blob.arrayBuffer());
    return String(bytes) === String(pdfBytes(7)) || "the restored document is not the file that was backed up";
  });

  await must("...and its highlights and their notes with it", async () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    if ((snapshot.meta?.pdfHighlights || []).length !== 6) return `${(snapshot.meta?.pdfHighlights || []).length} highlights restored`;
    return /the spindle forms here/.test(snapshot.notes) || "the notes written on the highlights did not come back";
  });

  await must("the empty folder comes back too", () =>
    folders.readKnownFolders().includes("Papers/Unread")
    || `known folders are ${JSON.stringify(folders.readKnownFolders())}`);

  await must("the reading position comes back, re-keyed to the restored deck", () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const key = libraryState.buildDeckKey({ deckId: "cloud-paper", localDeckId: paper.id, folderKey: null });
    const stored = readingPosition.readStoredReadingPosition(key);
    return stored?.offset === 900 || `no position under ${key} — stored keys are ${JSON.stringify(Object.keys(readingPosition.readAllReadingPositions()))}`;
  });

  await must("restoring the same archive twice changes nothing the second time", async () => {
    const report = await restoreArchive(archiveBytes, { confirm: false });
    const changed = report.decks.filter((entry) => entry.status !== "unchanged");
    return changed.length === 0
      || `${changed.length} deck(s) would change again: ${changed.map((entry) => `${entry.title}=${entry.status}`).join(", ")}`;
  });

  // ── C. A partial loss is repairable ─────────────────────────────────────

  await must("a backup restores highlights this device has lost half of", async () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    snapshot.meta.pdfHighlights = snapshot.meta.pdfHighlights.slice(0, 2);
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);

    const report = await restoreArchive(archiveBytes, { confirm: false });
    const entry = report.decks.find((row) => row.title === "Mitosis");
    if (entry.status !== "conflict") return `the preview called it ${entry.status}, so it would have restored nothing`;
    if (entry.counts.highlightsRestored !== 4) return `the preview promises ${entry.counts.highlightsRestored} highlights back, not 4`;
    await restore.applyRestore(report, { autoBackup: false });
    const after = await deckStore.readDeckSnapshot(paper.id);
    return (after.meta.pdfHighlights || []).length === 6
      || `${(after.meta.pdfHighlights || []).length} highlights after the restore`;
  });

  await must("...but never resurrects one the reader deleted on purpose", async () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    snapshot.meta.pdfHighlights = snapshot.meta.pdfHighlights.filter((record) => record.id !== "hn-h4");
    snapshot.meta.deletedHighlightIds = { "hn-h4": iso(T0 + 500000) };
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);

    await restoreArchive(archiveBytes);
    const after = await deckStore.readDeckSnapshot(paper.id);
    return !(after.meta.pdfHighlights || []).some((record) => record.id === "hn-h4")
      || "a deleted highlight came back from the backup";
  });

  await must("a bookmark lost locally comes back", async () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    delete snapshot.meta.bookmark;
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);
    await restoreArchive(archiveBytes);
    const after = await deckStore.readDeckSnapshot(paper.id);
    return after.meta.bookmark?.offset === 120 || "the bookmark did not come back";
  });

  await must("...and a newer local bookmark is not overwritten by an older one", async () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    snapshot.meta.bookmark = { offset: 4242, text: "later", at: T0 + 9_000_000 };
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);
    await restoreArchive(archiveBytes);
    const after = await deckStore.readDeckSnapshot(paper.id);
    return after.meta.bookmark?.offset === 4242 || `the restore replaced a newer bookmark with the archive's (${after.meta.bookmark?.offset})`;
  });

  await must("...and an OLDER local bookmark gives way to the archive's newer one", async () => {
    // The discriminating case for the whole meta merge. `{ ...backup, ...local }`
    // — what this used to be — keeps the local value here too, which looks
    // conservative and is not: the bookmark carries its own `at` precisely so
    // the LATER one wins, and a device restoring a backup taken after its own
    // copy went stale would keep the stale one forever.
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    snapshot.meta.bookmark = { offset: 1, text: "stale", at: T0 - 100000 };
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);
    await restoreArchive(archiveBytes);
    const after = await deckStore.readDeckSnapshot(paper.id);
    return after.meta.bookmark?.offset === 120
      || `the restore kept a bookmark older than the archive's (offset ${after.meta.bookmark?.offset})`;
  });

  await must("note-link ids are unioned, not replaced", async () => {
    // Every device mints its own, so each side holds a piece of the truth and a
    // union is the only answer that does not break a [[link]] written elsewhere.
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    snapshot.meta.linkIds = ["lnk-local"];
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);
    await restoreArchive(archiveBytes);
    const after = await deckStore.readDeckSnapshot(paper.id);
    const ids = after.meta.linkIds || [];
    return (ids.includes("lnk-a") && ids.includes("lnk-local"))
      || `linkIds after the restore are ${JSON.stringify(ids)} — one side's ids were dropped`;
  });

  await must("a highlight's note comes back even when the local body wins", async () => {
    // The other half of a partial loss, and the one that is invisible in a
    // highlight count: the words written ON a highlight live in a fenced block
    // at the end of the deck's notes. Treating that body as one last-write-wins
    // string restored the records and left every note gone.
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    snapshot.notes = "Reading notes, rewritten locally and therefore newer.\n";
    snapshot.meta.pdfHighlights = snapshot.meta.pdfHighlights.slice(0, 1);
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);
    const index = localLibrary.readLocalDeckIndex();
    localLibrary.writeLocalDeckIndex(index.map((row) => (row.id === paper.id ? { ...row, updatedAt: iso(T0 + 10_000_000) } : row)));

    await restoreArchive(archiveBytes);
    const after = await deckStore.readDeckSnapshot(paper.id);
    if (!/rewritten locally/.test(after.notes)) return "the restore replaced a newer local note body";
    return /the spindle forms here/.test(after.notes)
      || "the highlight notes did not survive a restore where the local body won";
  });

  await must("a local-only card is never dropped by a restore", async () => {
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const snapshot = await deckStore.readDeckSnapshot(paper.id);
    snapshot.cards.push({ id: "local-only", question: "Written after the backup", answer: "", status: null, category: null });
    deckStore.writeDeckSnapshot(paper.id, snapshot);
    await deckStore.deckWriteSettled(paper.id);
    await restoreArchive(archiveBytes);
    const after = await deckStore.readDeckSnapshot(paper.id);
    return after.cards.some((card) => card.id === "local-only") || "the restore deleted a card only this device had";
  });

  // ── D. The papers, on the device that already has them ──────────────────

  await must("a same-device restore re-keys the bytes it already has", async () => {
    resetWorld();
    // The library index is gone; the document store is not. This is the shape of
    // "I cleared site data on the wrong tab" and of every restore into a profile
    // that still holds its files — and it used to leave the paper unreadable,
    // because the store is keyed by a local id the restore replaces.
    await pdfStore.putDocument({ deckLocalId: "ld_paper", blob: new Blob([pdfBytes(7)], { type: "application/pdf" }), sha256: "", name: "mitosis.pdf", at: T0 });
    const report = await restoreArchive(archiveBytes, { confirm: false });
    await restore.applyRestore(report, { autoBackup: false });
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const row = await pdfStore.readDocument(paper.id);
    return Boolean(row?.blob) || "the restored deck's paper is not reachable under its new local id";
  });

  await must("an UNCHANGED deck still gets its paper back", async () => {
    resetWorld();
    await restoreArchive(archiveBytes);
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    // The decks are intact and the documents are not — a cleared document store,
    // a device that ran out of space and dropped the big rows, an offloaded
    // paper. Every deck previews as "unchanged", and a restore that only looked
    // at the decks it was writing left every one of those papers behind.
    await pdfStore.deleteLocalDocument(paper.id);
    const report = await restoreArchive(archiveBytes, { confirm: false });
    if (report.decks.every((entry) => entry.status !== "unchanged")) return "no deck previewed as unchanged, so nothing was under test";
    await restore.applyRestore(report, { autoBackup: false });
    const row = await pdfStore.readDocument(paper.id);
    return Boolean(row?.blob) || "an unchanged deck's paper was not restored";
  });

  await must("a paper whose hash disagrees with its deck is refused, not stored", async () => {
    resetWorld();
    // The archive says one file; the deck's own record says another. The
    // highlights are coordinates into the deck's file, so storing this one puts
    // every one of them on the wrong page.
    const tampered = await rewriteArchive(archiveBytes, async (name, entry) => {
      if (name === "documents/index.json") {
        const index = JSON.parse(await entry.async("string"));
        index.documents[0].sha256 = "0".repeat(64);
        index.documents[0].metaSha256 = "f".repeat(64);
        return `${JSON.stringify(index, null, 2)}\n`;
      }
      return undefined;
    });
    const report = await restoreArchive(tampered, { confirm: false });
    await restore.applyRestore(report, { autoBackup: false });
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const row = await pdfStore.readDocument(paper.id);
    return !row?.blob || "a PDF that does not match the deck's own record was stored anyway";
  });

  await must("a damaged PDF is caught when it is stored, not trusted", async () => {
    resetWorld();
    // The archive's index records the hash of the file it packed. Truncate the
    // file and leave the index alone: nothing up front reads a paper's bytes
    // (that would mean decompressing a library of them in front of a preview),
    // so this has to be caught at the one moment the bytes are in hand.
    const damaged = await rewriteArchive(archiveBytes, async (name, entry) => (
      name.startsWith("documents/") && name.endsWith(".pdf")
        ? (await entry.async("uint8array")).slice(0, 4)
        : undefined
    ));
    const report = await restoreArchive(damaged, { confirm: false });
    await restore.applyRestore(report, { autoBackup: false });
    const paper = localLibrary.readLocalDeckIndex().find((deck) => deck.title === "Mitosis");
    const row = await pdfStore.readDocument(paper.id);
    return !row?.blob || "a truncated PDF was stored as though it were the paper";
  });

  // ── E. The archive is checked against its own index ─────────────────────

  await must("an intact archive verifies", async () => {
    const zip = await openArchive(archiveBytes);
    const manifest = JSON.parse(await readEntry(archiveBytes, "manifest.json"));
    const result = archiveFormat.verifyBackupArchive(Object.keys(zip.files), manifest);
    return (result.checked && result.ok) || `verification said ${JSON.stringify(result.notes)}`;
  });

  await must("a deck file missing from the archive is reported, not ignored", async () => {
    const damaged = await rewriteArchive(archiveBytes, (name) => (/^decks\/Math\//.test(name) ? null : undefined));
    const archive = await restore.readBackupArchive(archiveFile(damaged));
    if (!archive.verification?.checked) return "the archive was not checked at all";
    if (archive.verification.ok) return "a missing deck file passed verification";
    return archive.verification.missingFiles.length === 1
      || `missingFiles is ${JSON.stringify(archive.verification.missingFiles)}`;
  });

  await must("a truncated file is reported even though it is present", async () => {
    const damaged = await rewriteArchive(archiveBytes, async (name, entry) => (
      /^decks\/Science\//.test(name) ? (await entry.async("string")).slice(0, 40) : undefined
    ));
    const archive = await restore.readBackupArchive(archiveFile(damaged));
    return (archive.verification && !archive.verification.ok && archive.verification.mismatched.length > 0)
      || "a truncated deck file passed verification";
  });

  await must("...and the readable decks are still restorable", async () => {
    resetWorld();
    const damaged = await rewriteArchive(archiveBytes, (name) => (/^decks\/Math\//.test(name) ? null : undefined));
    await restoreArchive(damaged);
    const index = localLibrary.readLocalDeckIndex();
    return index.length === 2 || `${index.length} decks restored from a damaged archive`;
  });

  await must("a v2 archive's folders still come back, from the manifest", async () => {
    resetWorld();
    // No library.json — the shape of every archive written before this change.
    // The manifest has listed the folders since the format existed and nothing
    // ever read it, so an empty folder was lost by design.
    const v2ish = await rewriteArchive(archiveBytes, (name) => (name === "library.json" ? null : undefined));
    await restoreArchive(v2ish);
    return folders.readKnownFolders().includes("Papers/Unread")
      || `known folders after a v2-shaped restore are ${JSON.stringify(folders.readKnownFolders())}`;
  });

  await must("an archive with no manifest is read, and says it was not checked", async () => {
    const v2ish = await rewriteArchive(archiveBytes, (name) => (name === "manifest.json" ? null : undefined));
    const archive = await restore.readBackupArchive(archiveFile(v2ish));
    if (archive.verification) return "an archive with no index claimed to have been checked";
    return archive.decks.length === 3 || `${archive.decks.length} decks read from a v2-shaped archive`;
  });

  // ── F. Hand-made and legacy archives ────────────────────────────────────

  await must("a hand-made zip's folders become the decks' folders", async () => {
    resetWorld();
    const zip = new zipLite.LiteZip();
    zip.file("Chemistry/Bonding.json", JSON.stringify({
      deckTitle: "Bonding", cards: [{ id: "b0", question: "Ionic?", answer: "Transfer" }]
    }));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await restoreArchive(bytes);
    const deck = localLibrary.readLocalDeckIndex().find((row) => row.title === "Bonding");
    return deck?.category === "Chemistry" || `it landed in ${deck?.category}`;
  });

  await must("the archive's own index files are never mistaken for decks", async () => {
    resetWorld();
    // No decks/ root, so the unstructured fallback fires — and library.json and
    // documents/index.json are sitting right there, both perfectly good JSON.
    const zip = new zipLite.LiteZip();
    zip.file("Loose.json", JSON.stringify({ deckTitle: "Loose", cards: [{ id: "l0", question: "Q", answer: "A" }] }));
    zip.file("library.json", JSON.stringify({ schema: "recall-backup-library", version: 1, folders: { known: [] }, readingPositions: [], bookmarkPrompts: [] }));
    zip.file("documents/index.json", JSON.stringify({ schema: "recall-backup-documents", version: 1, documents: [], missing: [] }));
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const archive = await restore.readBackupArchive(archiveFile(bytes));
    return archive.decks.length === 1 || `${archive.decks.length} decks found — the index files were read as decks`;
  });

  await must("two untitled decks sharing a title do not collide", () => {
    const a = { title: "Notes", category: "", notes: "first", meta: {}, cards: [{ id: "a", question: "one" }], deckId: null };
    const b = { title: "Notes", category: "", notes: "second", meta: {}, cards: [{ id: "b", question: "two" }], deckId: null };
    return restore.deterministicRestoreLocalId(a) !== restore.deterministicRestoreLocalId(b)
      || "both decks resolve to the same local id, so one overwrites the other";
  });

  // ── G. A restore reports only what landed ───────────────────────────────

  await must("a restore awaits its writes before it reports", () => {
    const text = readFileSync(path.join(ROOT, "src/backup/restore.js"), "utf8");
    const body = text.match(/export async function applyRestore[\s\S]*?\n}\n/)?.[0] || "";
    if (/report\.decks\.forEach/.test(body)) return "applyRestore still writes its decks from a synchronous forEach";
    return /await deckWriteSettled\(/.test(body)
      || "applyRestore does not wait for a deck write to commit before counting it";
  });

  await must("a deck the store refuses is reported as failed, not as restored", async () => {
    resetWorld();
    // A store that rejects one deck's write, the way a full disk does: after the
    // call returned, in the background. That is precisely what the old
    // synchronous forEach could not see — it counted the deck and printed
    // "Restore complete" over a write that never happened.
    const table = databases.get("recall-decks")?.get("snapshots");
    if (!table) return "the deck store was never opened, so nothing was under test";
    const realSet = table.rows.set.bind(table.rows);
    let refusedId = "";
    table.rows.set = (key, row) => {
      if (!refusedId && String(key).startsWith("ld_restore")) {
        refusedId = String(key);
        throw new Error("QuotaExceededError");
      }
      return realSet(key, row);
    };
    const report = await restoreArchive(archiveBytes, { confirm: false });
    try {
      await restore.applyRestore(report, { autoBackup: false });
    } finally {
      table.rows.set = realSet;
    }
    const index = localLibrary.readLocalDeckIndex();
    if (!refusedId) return "no write was refused, so nothing was under test";
    if (index.length !== 2) return `${index.length} decks in the index — a refused write was recorded as a restored deck`;
    return true;
  });

  // ── H. Coverage — the half that keeps this fixed ────────────────────────

  await must("every deck-meta key is named in the coverage table", () => {
    // Three scanners unioned, because a key reaches the bag three ways: written
    // straight onto it, spread into a fresh literal, or named by the merge that
    // by construction has to know all of them.
    const found = new Set();
    for (const [rel, text] of sources) {
      if (rel === "src/backup/archive-format.js") continue; // the table itself
      for (const match of text.matchAll(/\.meta\??\.([A-Za-z_$][\w$]*)/g)) found.add(match[1]);
      if (rel === "src/storage/deck-snapshot.js" || rel === "src/sync/document-sync.js" || rel === "src/backup/backup.js") {
        for (const match of text.matchAll(/\b(?:metaBag|merged|next)\.([A-Za-z_$][\w$]*)\s*=/g)) found.add(match[1]);
      }
    }
    // `meta` is also the name the library index goes by in several places; those
    // are records, not the deck's bag, and their fields are not meta keys.
    const INDEX_FIELDS = new Set(["id", "title", "category", "cardCount", "hasNotes", "updatedAt", "createdAt", "lastSyncedAt", "accessedAt", "deckId", "icon", "label", "percent", "className", "textContent", "appendChild", "append"]);
    const known = new Set([
      ...Object.keys(archiveFormat.BACKED_UP_META_KEYS),
      ...Object.keys(archiveFormat.NOT_BACKED_UP_META_KEYS)
    ]);
    const unnamed = [...found].filter((key) => !known.has(key) && !INDEX_FIELDS.has(key));
    return unnamed.length === 0
      || `deck meta key(s) the backup has never been told about: ${unnamed.join(", ")}. `
        + "Add each to BACKED_UP_META_KEYS or NOT_BACKED_UP_META_KEYS in src/backup/archive-format.js, with the reason.";
  });

  await must("...and every key the table claims is carried survives a round trip", async () => {
    const missed = [];
    for (const key of Object.keys(archiveFormat.BACKED_UP_META_KEYS)) {
      resetWorld();
      const value = META_FIXTURES[key];
      if (value === undefined) { missed.push(`${key} (no fixture)`); continue; }
      await seedDeck({ localId: "ld_one", deckId: "cloud-one", title: "One", notes: "body", meta: { [key]: value }, cards: [{ id: "x", question: "q" }], updatedAt: T0 });
      const bytes = await takeBackup();
      resetWorld();
      await restoreArchive(bytes);
      const deck = localLibrary.readLocalDeckIndex()[0];
      const snapshot = deck ? await deckStore.readDeckSnapshot(deck.id) : null;
      if (JSON.stringify(snapshot?.meta?.[key]) !== JSON.stringify(value)) {
        missed.push(`${key} (got ${JSON.stringify(snapshot?.meta?.[key])})`);
      }
    }
    return missed.length === 0 || `meta key(s) the table promises but the archive loses: ${missed.join(", ")}`;
  });

  await must("every IndexedDB database is named in the coverage table", () => {
    const found = new Set();
    for (const [, text] of sources) {
      for (const match of text.matchAll(/indexedDB\.open\(\s*([A-Za-z_$][\w$]*)/g)) {
        const name = match[1];
        // The call sites pass a constant; resolve it to its literal.
        for (const [, source] of sources) {
          const declared = source.match(new RegExp(`export const ${name} = "([^"]+)"`));
          if (declared) found.add(declared[1]);
        }
      }
      for (const match of text.matchAll(/indexedDB\.open\(\s*"([^"]+)"/g)) found.add(match[1]);
    }
    const known = new Set([
      ...Object.keys(archiveFormat.BACKED_UP_STORES),
      ...Object.keys(archiveFormat.NOT_BACKED_UP_STORES)
    ]);
    const unnamed = [...found].filter((name) => !known.has(name));
    if (!found.size) return "the scan found no IndexedDB databases at all, which means it has stopped working";
    return unnamed.length === 0
      || `IndexedDB database(s) the backup has never been told about: ${unnamed.join(", ")}. `
        + "Add each to BACKED_UP_STORES or NOT_BACKED_UP_STORES in src/backup/archive-format.js, with the reason.";
  });

  await must("the archive never carries a credential", async () => {
    resetWorld();
    localStorage.setItem(keys.SUPABASE_CONFIG_STORAGE_KEY ?? "flashcards_supabase_config", JSON.stringify({ url: "https://example.supabase.co", anonKey: "SECRET-ANON-KEY" }));
    localStorage.setItem("sb-example-auth-token", "SECRET-SESSION-TOKEN");
    await seedDeck({ localId: "ld_one", title: "One", notes: "body", cards: [{ id: "x", question: "q" }], updatedAt: T0 });
    const bytes = await takeBackup();
    const zip = await openArchive(bytes);
    for (const name of Object.keys(zip.files)) {
      if (zip.files[name].dir) continue;
      const text = await zip.files[name].async("string");
      if (/SECRET-ANON-KEY|SECRET-SESSION-TOKEN|supabase_config|auth-token/.test(text)) {
        return `${name} contains a credential — a backup is a file people mail to themselves`;
      }
    }
    return true;
  });

  // ── I. A backup can be taken with no zip library ────────────────────────

  await must("the backup does not need the CDN", () => {
    // Everything above ran with JSZip absent and document.head.appendChild
    // failing the script load, which is the state a blocked CDN puts a user in.
    // The archive exists, so the fallback carried it — this case names that
    // rather than leaving it as an accident of the harness.
    return archiveBytes.length > 0 || "no archive was produced without JSZip";
  });

  await must("...and the archive it writes is a real zip", () => {
    const magic = String.fromCharCode(archiveBytes[0], archiveBytes[1], archiveBytes[2], archiveBytes[3]);
    return magic === "PK" || `the archive does not start with a local file header (${JSON.stringify(magic)})`;
  });

  // ── J. The record and the reminder ──────────────────────────────────────

  await must("a finished backup is recorded", () => {
    const record = history.readLastBackup();
    return Boolean(record?.at && record.decks) || `the last-backup record is ${JSON.stringify(record)}`;
  });

  await must("a safety backup does not move the reminder", () => {
    store.clear();
    history.recordBackup({ decks: 3, name: "manual.zip", kind: "manual" });
    const manualAt = history.readLastBackup().at;
    history.recordBackup({ decks: 3, name: "before-restore.zip", kind: "safety" });
    return history.readLastBackup().at === manualAt
      || "restoring something told the user they had backed up";
  });

  await must("the reminder waits for a change, not just for time", () => {
    const old = { at: iso(T0), decks: 3 };
    const quiet = history.backupNudgeDue({ record: old, changedAt: T0 - 1000, deckCount: 3, now: T0 + 40 * 86400000 });
    const busy = history.backupNudgeDue({ record: old, changedAt: T0 + 86400000, deckCount: 3, now: T0 + 40 * 86400000 });
    if (quiet) return "a library nobody has touched is nagged about";
    if (!busy) return "a library that changed weeks ago is not mentioned at all";
    return history.backupNudgeDue({ record: null, changedAt: T0, deckCount: 3, now: T0 })
      || "a library that has never been backed up is not mentioned";
  });

  console.warn = realWarn;
  console.error = realError;
  console.log("── backup ──");
  for (const [ok, name, detail] of results) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : " — " + detail}`);
  }
  console.log(`\n  ${results.length} checks · ${failures} failed`
    + (appWarnings.length ? ` · ${appWarnings.length} app warning(s), expected (--verbose to read them)` : ""));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
