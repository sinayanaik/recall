// Drive the WHOLE two-way sync, on both builds, against the same fake backend.
//
//   node tools/reconcile-parity.mjs
//   node tools/reconcile-parity.mjs --base=REF
//
// tools/sync-parity.mjs tests the merge primitives. This tests the thing that
// calls them: reconcileAllDecks, end to end, with a real local library in
// IndexedDB and a stand-in Supabase in memory.
//
// The fake does not have to be a faithful Supabase. It has to be the SAME for
// both sides — the question is whether the restructure changed what the sync
// does, and a divergence shows up regardless of how the backend behaves. On top
// of that the scenarios assert outcomes that must hold whatever the backend is:
// a deck present on one side and absent on the other must end up on both, and
// nothing may vanish from a device that had it.
//
// Scenarios are run in a fresh page each time (fresh IndexedDB, fresh
// localStorage), because sync state persists by design.

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
if (!puppeteer || !CHROME) { console.log("reconcile-parity: no puppeteer/Chrome — skipping."); process.exit(0); }

// ── The fake backend, injected into the page ───────────────────────────────
const FAKE_SUPABASE = String.raw`(seedCloud) => {
  const db = JSON.parse(JSON.stringify(seedCloud));
  db.decks ||= []; db.cards ||= []; db.deleted_decks ||= []; db.app_style_settings ||= [];
  const log = [];

  const matches = (row, filters) => filters.every((f) => {
    const v = row[f.col];
    if (f.op === "eq") return String(v) === String(f.val);
    if (f.op === "neq") return String(v) !== String(f.val);
    if (f.op === "in") return f.val.map(String).includes(String(v));
    return true;
  });

  function query(table) {
    const q = { table, filters: [], op: "select", cols: "*", payload: null, orderBy: null, rangeTo: null, single: false };
    const api = {
      select(cols) { q.op = q.op === "select" ? "select" : q.op; q.cols = cols || "*"; return api; },
      insert(rows) { q.op = "insert"; q.payload = rows; return api; },
      upsert(rows) { q.op = "upsert"; q.payload = rows; return api; },
      update(patch) { q.op = "update"; q.payload = patch; return api; },
      delete() { q.op = "delete"; return api; },
      eq(col, val) { q.filters.push({ op: "eq", col, val }); return api; },
      neq(col, val) { q.filters.push({ op: "neq", col, val }); return api; },
      in(col, val) { q.filters.push({ op: "in", col, val }); return api; },
      order(col, opts) { q.orderBy = { col, asc: !opts || opts.ascending !== false }; return api; },
      range(from, to) { q.rangeTo = [from, to]; return api; },
      limit(n) { q.rangeTo = [0, n - 1]; return api; },
      abortSignal() { return api; },
      single() { q.single = true; return api; },
      maybeSingle() { q.single = true; return api; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); }
    };

    function run() {
      log.push(q.op + " " + q.table);
      const rows = db[q.table] || (db[q.table] = []);
      if (q.op === "select") {
        let out = rows.filter((r) => matches(r, q.filters)).map((r) => ({ ...r }));
        if (q.orderBy) out.sort((a, b) => {
          const x = a[q.orderBy.col], y = b[q.orderBy.col];
          const c = x === y ? 0 : (x > y ? 1 : -1);
          return q.orderBy.asc ? c : -c;
        });
        if (q.rangeTo) out = out.slice(q.rangeTo[0], q.rangeTo[1] + 1);
        if (q.single) return { data: out[0] ?? null, error: out.length ? null : { code: "PGRST116", message: "no rows" } };
        return { data: out, error: null };
      }
      if (q.op === "delete") {
        const keep = rows.filter((r) => !matches(r, q.filters));
        db[q.table] = keep;
        return { data: null, error: null };
      }
      if (q.op === "update") {
        for (const r of rows) if (matches(r, q.filters)) Object.assign(r, q.payload);
        return { data: null, error: null };
      }
      // insert / upsert, keyed by the table's primary key
      const key = q.table === "cards" ? "id" : q.table === "deleted_decks" ? "deck_id" : "id";
      for (const row of [].concat(q.payload || [])) {
        const i = rows.findIndex((r) => String(r[key]) === String(row[key]));
        if (i === -1) rows.push({ ...row });
        else rows[i] = { ...rows[i], ...row };
      }
      return { data: null, error: null };
    }
    return api;
  }

  const user = { id: "user-1", email: "you@example.com" };
  return {
    __db: db,
    __log: log,
    from: query,
    auth: {
      getSession: async () => ({ data: { session: { user, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }),
                              remove: async () => ({ data: [], error: null }),
                              upload: async () => ({ data: null, error: { message: "no storage in test" } }),
                              getPublicUrl: () => ({ data: { publicUrl: "" } }) }) }
  };
}`;

// ── Scenarios ──────────────────────────────────────────────────────────────
const SCENARIOS = String.raw`[
  {
    name: "cloud-only deck is pulled down",
    local: [],
    cloud: {
      decks: [{ id: "d-cloud", title: "From cloud", category: "C", notes: "cloud notes", meta: {},
                current_card_index: 0, user_id: "user-1",
                updated_at: "2026-06-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
                last_accessed_at: "2026-06-01T00:00:00.000Z" }],
      cards: [{ id: "c1", deck_id: "d-cloud", question: "Q1", answer: "A1", position: 0,
                status: null, category: null, updated_at: "2026-06-01T00:00:00.000Z" }]
    }
  },
  {
    name: "local-only deck is pushed up",
    local: [{ localId: "L1", deckId: null, title: "Local only", category: "C", notes: "local notes",
              cards: [{ id: "x1", question: "LQ", answer: "LA", status: null }],
              updatedAt: "2026-06-01T00:00:00.000Z", lastSyncedAt: null }],
    cloud: { decks: [], cards: [] }
  },
  {
    name: "both sides have the deck, cloud edited more recently",
    local: [{ localId: "L2", deckId: "d-both", title: "Shared", category: "C", notes: "local notes",
              cards: [{ id: "s1", question: "local Q", answer: "A", status: null, dirty: false,
                        updatedAt: "2026-01-01T00:00:00.000Z" }],
              updatedAt: "2026-01-01T00:00:00.000Z", lastSyncedAt: "2026-01-01T00:00:00.000Z" }],
    cloud: {
      decks: [{ id: "d-both", title: "Shared", category: "C", notes: "cloud notes", meta: {},
                current_card_index: 0, user_id: "user-1",
                updated_at: "2026-09-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
                last_accessed_at: "2026-09-01T00:00:00.000Z" }],
      cards: [{ id: "s1", deck_id: "d-both", question: "cloud Q", answer: "A", position: 0,
                status: null, category: null, updated_at: "2026-09-01T00:00:00.000Z" }]
    }
  },
  {
    name: "the cloud returns nothing at all",
    local: [{ localId: "L3", deckId: "d-keep", title: "Keep me", category: "C", notes: "n",
              cards: [{ id: "k1", question: "Q", answer: "A", status: null }],
              updatedAt: "2026-06-01T00:00:00.000Z", lastSyncedAt: "2026-06-01T00:00:00.000Z" },
             { localId: "L4", deckId: "d-keep2", title: "Keep me too", category: "C", notes: "n",
               cards: [{ id: "k2", question: "Q", answer: "A", status: null }],
               updatedAt: "2026-06-01T00:00:00.000Z", lastSyncedAt: "2026-06-01T00:00:00.000Z" }],
    cloud: { decks: [], cards: [] }
  },
  {
    name: "a deck the user deleted stays deleted",
    local: [],
    cloud: {
      decks: [{ id: "d-gone", title: "Deleted", category: "C", notes: "", meta: {},
                current_card_index: 0, user_id: "user-1",
                updated_at: "2026-06-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z",
                last_accessed_at: "2026-06-01T00:00:00.000Z" }],
      cards: [],
      deleted_decks: [{ deck_id: "d-gone", user_id: "user-1", deleted_at: "2026-07-01T00:00:00.000Z" }]
    }
  }
]`;

// Runs one scenario in the page and returns a normalised snapshot of both sides.
const RUN_ONE = String.raw`async (api, scenario, fakeSrc) => {
  localStorage.clear();
  await api.initDeckStorage();
  await api.clearAllDeckSnapshots();

  // Seed the local library: a snapshot per deck plus its index entry.
  const index = [];
  for (const d of scenario.local) {
    await api.writeDeckSnapshot(d.localId, {
      app: "recall", deckId: d.deckId, deckTitle: d.title, deckCategory: d.category,
      notes: d.notes, meta: {}, cards: d.cards, current: 0
    });
    index.push({
      id: d.localId, title: d.title, category: d.category, cardCount: d.cards.length,
      updatedAt: d.updatedAt, createdAt: "2026-01-01T00:00:00.000Z",
      lastSyncedAt: d.lastSyncedAt, accessedAt: null, deckId: d.deckId,
      notesConflicted: false, notesSyncFailed: false
    });
  }
  api.writeLocalDeckIndex(index);

  const fake = (0, eval)("(" + fakeSrc + ")")(scenario.cloud);
  api.__setClient(fake);
  api.__setSignedIn(true);

  await api.reconcileAllDecks({ explicit: true });

  // Normalise both sides: only what a user would notice.
  const ids = await api.allDeckSnapshotIds();
  const localOut = [];
  for (const id of ids.slice().sort()) {
    const s = await api.readDeckSnapshot(id);
    if (!s) continue;
    localOut.push({
      title: s.deckTitle, category: s.deckCategory, notes: s.notes,
      cards: (s.cards || []).map((c) => ({ id: c.id, q: c.question, a: c.answer, status: c.status ?? null }))
                            .sort((x, y) => String(x.id).localeCompare(String(y.id)))
    });
  }
  localOut.sort((a, b) => String(a.title).localeCompare(String(b.title)));

  // A deck pushed for the first time is given an id built from its title, the
  // clock and a random suffix, so it necessarily differs between two runs.
  // Collapse the minted part; what matters is that a deck arrived, with the
  // right title and notes, and that its cards point at it.
  const mint = (id) => String(id).replace(/-[a-z0-9]{6,}-[a-z0-9]{3,}$/, "-<minted>");
  const cloudOut = {
    decks: (fake.__db.decks || []).map((d) => ({ id: mint(d.id), title: d.title, notes: d.notes }))
             .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    cards: (fake.__db.cards || []).map((c) => ({ id: c.id, deck: mint(c.deck_id), q: c.question, a: c.answer }))
             .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    tombstones: (fake.__db.deleted_decks || []).map((t) => t.deck_id).sort()
  };
  return { local: localOut, cloud: cloudOut };
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

async function runAll(url, apiSrc) {
  const browser = await puppeteer.launch({ headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const results = {};
  const errors = [];
  try {
    const scenarios = JSON.parse(JSON.stringify(eval(SCENARIOS)));
    for (const scenario of scenarios) {
      // A fresh page per scenario: sync state persists on purpose.
      const page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(scenario.name + ": " + e.message));
      page.on("dialog", (d) => d.dismiss().catch(() => {}));
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await new Promise((r) => setTimeout(r, 700));
      try {
        results[scenario.name] = await page.evaluate(
          async (runSrc, apiS, sc, fakeSrc) => {
            const api = await (0, eval)(apiS)();
            return (0, eval)("(" + runSrc + ")")(api, sc, fakeSrc);
          },
          RUN_ONE, apiSrc, scenario, FAKE_SUPABASE
        );
      } catch (e) {
        results[scenario.name] = { error: String(e.message).slice(0, 300) };
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return { results, errors };
}

  // NOTE: ?v=__BUILD__ on every import, matching what the app's own modules ask
  // for. A module's URL is its identity — importing "/src/cloud/supabase-client.js"
  // and "/src/cloud/supabase-client.js?v=__BUILD__" yields TWO instances with
  // separate state. Without the stamp this harness set the client on one
  // instance while reconcile read from another, saw none, and returned
  // immediately: every scenario "passed" by doing nothing at all.
const MODULE_API = `async () => {
  const mods = await Promise.all([
    import("/src/sync/reconcile.js?v=__BUILD__"), import("/src/storage/deck-store.js?v=__BUILD__"),
    import("/src/library/local-library.js?v=__BUILD__"), import("/src/cloud/supabase-client.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  const sc = await import("/src/cloud/supabase-client.js?v=__BUILD__");
  api.__setClient = sc.setSupabaseClient;
  api.__setSignedIn = sc.setSignedIn;
  return api;
}`;

const servers = [];
const temps = [];
let failures = 0;
try {
  const baseDir = mkdtempSync(path.join(tmpdir(), "recall-rec-"));
  temps.push(baseDir);
  execFileSync("bash", ["-c", `git archive ${BASE_REF} | tar -x -C ${baseDir}`], { cwd: ROOT });
  const NAMES = ["reconcileAllDecks", "initDeckStorage", "clearAllDeckSnapshots", "writeDeckSnapshot",
                 "readDeckSnapshot", "allDeckSnapshotIds", "writeLocalDeckIndex"];
  // The baseline's supabaseClient/isSignedIn are `let`s inside the script scope,
  // so the wrapper hands back closures that can write them.
  writeFileSync(path.join(baseDir, "probe.js"),
    `window.__recallApi = (function () {\n${readFileSync(path.join(baseDir, "app.js"), "utf8")}\n;return {\n` +
    NAMES.map((n) => `  ${n},`).join("\n") +
    `\n  __setClient: (c) => { supabaseClient = c; },\n  __setSignedIn: (v) => { isSignedIn = v; }\n};\n})();\n`);
  writeFileSync(path.join(baseDir, "index.html"),
    readFileSync(path.join(baseDir, "index.html"), "utf8")
      .replace('<script src="app.js?v=__BUILD__"></script>', '<script src="probe.js"></script>'));
  const __s_baseDir = await serveOn(baseDir); servers.push(__s_baseDir.proc);
  const __s_ROOT = await serveOn(ROOT); servers.push(__s_ROOT.proc);
  await new Promise((r) => setTimeout(r, 1500));

  const before = await runAll(`${__s_baseDir.base}/index.html`, "async () => window.__recallApi");
  const after = await runAll(`${__s_ROOT.base}/index.html`, MODULE_API);

  console.log("── reconcileAllDecks, end to end, vs " + BASE_REF + " ──");
  const names = Object.keys(after.results);
  for (const n of names) {
    const a = JSON.stringify(before.results[n]);
    const b = JSON.stringify(after.results[n]);
    const same = a === b;
    console.log(`  ${same ? "ok  " : "DIFF"}  ${n}`);
    if (!same) {
      failures++;
      console.log(`        was: ${String(a).slice(0, 320)}`);
      console.log(`        now: ${String(b).slice(0, 320)}`);
    }
  }

  // Outcome assertions — true whatever the backend does.
  console.log("\n── outcomes (current code) ──");
  const outcome = (ok, msg) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`); if (!ok) failures++; };
  const r = after.results;
  outcome(r["cloud-only deck is pulled down"]?.local?.length === 1,
    "a cloud-only deck arrives on the device");
  outcome(r["local-only deck is pushed up"]?.cloud?.decks?.length === 1,
    "a local-only deck reaches the cloud");
  outcome((r["local-only deck is pushed up"]?.cloud?.cards?.length || 0) === 1,
    "its cards reach the cloud too");
  outcome(r["the cloud returns nothing at all"]?.local?.length === 2,
    "an empty cloud does NOT delete the device's decks");
  outcome((r["the cloud returns nothing at all"]?.cloud?.tombstones?.length || 0) === 0,
    "an empty cloud does NOT publish deletions");
  outcome(r["a deck the user deleted stays deleted"]?.local?.length === 0,
    "a tombstoned deck is not resurrected onto the device");
  const both = r["both sides have the deck, cloud edited more recently"];
  outcome(both?.local?.length === 1 && both.local[0].cards.length === 1,
    "a deck edited on both sides converges to one deck, not two");

  if (after.errors.length) console.log(`\n  page errors: ${after.errors.slice(0, 4).join(" | ")}`);
  console.log(failures ? `\n${failures} reconcile problem(s).` : "\nreconcileAllDecks verified: identical on both builds, and no path loses data.");
} finally {
  for (const s of servers) s.kill();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
