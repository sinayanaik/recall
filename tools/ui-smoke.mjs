// Drive the app the way a person does, on both builds, and compare.
//
//   node tools/ui-smoke.mjs
//   node tools/ui-smoke.mjs --base=REF
//   node tools/ui-smoke.mjs --shot out.png     # also screenshot each step
//
// Everything else here tests functions. Nothing tests the app: the UI is behind
// a sign-in, so boot-check only ever saw the setup screen, and the entire
// surface a user actually touches — importing a deck, flipping a card, marking
// it known, opening All Cards, writing notes, exporting — has never once been
// clicked in any of these checks.
//
// So: sign in against a stand-in backend, then perform a sequence of real
// actions through the real DOM, recording what the app shows after each one.
// The same sequence runs against the pre-split build, and the two transcripts
// must match step for step.
//
// A step that throws is recorded rather than aborting the run, so one broken
// action does not hide the twenty after it.

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_REF = (process.argv.find((a) => a.startsWith("--base=")) || "--base=main").slice(7);
const SHOT = process.argv.includes("--shot");

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
if (!puppeteer || !CHROME) { console.log("ui-smoke: no puppeteer/Chrome — skipping."); process.exit(0); }

// Injected into both pages before any page script, so the CDN can be cut off
// entirely and the two builds always run identical library code. KaTeX is
// included because rendering a note reaches for renderMathInElement, and
// without it the notes steps throw on both builds and drown the transcript.
const VENDORED = [
  path.join(ROOT, "recall-clipper/vendor/marked.min.js"),
  path.join(ROOT, "recall-clipper/vendor/purify.min.js"),
  path.join(ROOT, "recall-clipper/vendor/katex/katex.min.js"),
  path.join(ROOT, "recall-clipper/vendor/katex/auto-render.min.js")
];

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl !== -1) resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

// An empty stand-in backend: enough to get past sign-in and let the app run.
const FAKE = String.raw`() => {
  const db = { decks: [], cards: [], deleted_decks: [], app_style_settings: [] };
  const match = (r, f) => f.every((x) => x.op === "eq" ? String(r[x.col]) === String(x.val)
    : x.op === "neq" ? String(r[x.col]) !== String(x.val)
    : x.op === "in" ? x.val.map(String).includes(String(r[x.col])) : true);
  const q = (t) => { const s = { t, f: [], op: "select", range: null, single: false, payload: null };
    const a = { select: () => a, insert: (r) => (s.op = "insert", s.payload = r, a),
      upsert: (r) => (s.op = "upsert", s.payload = r, a), update: (r) => (s.op = "update", s.payload = r, a),
      delete: () => (s.op = "delete", a), eq: (c, v) => (s.f.push({ op: "eq", col: c, val: v }), a),
      neq: (c, v) => (s.f.push({ op: "neq", col: c, val: v }), a),
      in: (c, v) => (s.f.push({ op: "in", col: c, val: v }), a), order: () => a,
      range: (x, y) => (s.range = [x, y], a), limit: (n) => (s.range = [0, n - 1], a),
      abortSignal: () => a, single: () => (s.single = true, a), maybeSingle: () => (s.single = true, a),
      then: (res, rej) => Promise.resolve(run()).then(res, rej) };
    function run() { const rows = db[s.t] || (db[s.t] = []);
      if (s.op === "select") { let o = rows.filter((r) => match(r, s.f)).map((r) => ({ ...r }));
        if (s.range) o = o.slice(s.range[0], s.range[1] + 1);
        return s.single ? { data: o[0] ?? null, error: o.length ? null : { code: "PGRST116" } } : { data: o, error: null }; }
      if (s.op === "delete") { db[s.t] = rows.filter((r) => !match(r, s.f)); return { data: null, error: null }; }
      if (s.op === "update") { for (const r of rows) if (match(r, s.f)) Object.assign(r, s.payload); return { data: null, error: null }; }
      const key = s.t === "deleted_decks" ? "deck_id" : "id";
      for (const row of [].concat(s.payload || [])) { const i = rows.findIndex((r) => String(r[key]) === String(row[key]));
        if (i === -1) rows.push({ ...row }); else rows[i] = { ...rows[i], ...row }; }
      return { data: null, error: null }; }
    return a; };
  const user = { id: "user-1", email: "you@example.com" };
  return { __db: db, from: q,
    auth: { getSession: async () => ({ data: { session: { user, access_token: "t" } }, error: null }),
            getUser: async () => ({ data: { user }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({ error: null }) },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }),
                              remove: async () => ({ data: [], error: null }),
                              upload: async () => ({ data: null, error: { message: "offline" } }),
                              getPublicUrl: () => ({ data: { publicUrl: "" } }) }) } };
}`;

// What the app is showing, after each action. Deliberately coarse — the point
// is "did both builds do the same thing", not pixel equality.
const SNAPSHOT = String.raw`() => {
  const vis = (sel) => { const n = document.querySelector(sel); return Boolean(n && !n.hidden && n.offsetParent !== null); };
  const txt = (sel) => (document.querySelector(sel)?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
  return {
    deckTitle: txt("#deckTitle"),
    meta: txt("#meta"),
    question: txt("#question").slice(0, 60),
    answerShown: vis("#answer"),
    view: document.body.dataset.view || (vis("#notesView") ? "notes" : "cards"),
    allCardsOpen: vis("#allCardsPanel"),
    allCardCount: document.querySelectorAll("#allCardsList .all-card").length,
    myDecksOpen: vis("#myDecksPanel"),
    importOpen: vis("#importPanel"),
    notesChars: (document.querySelector("#notesEdit")?.value || "").length,
    renderedBlocks: document.querySelectorAll("#notesRendered > *").length,
    toast: txt(".toast"),
    status: txt("#status")
  };
}`;

// The script. Each step is [name, code] run in the page; the snapshot after it
// goes into the transcript.
const STEPS = String.raw`[
  ["sign in", async (api) => {
    api.setSupabaseClient(api.__fake);
    api.setSignedIn(true);
    api.showAuthenticatedUI();
    api.initAppForUser();
    await new Promise((r) => setTimeout(r, 400));
  }],
  ["import the sample deck", async (api) => {
    api.stageMarkdownImport(api.sampleMarkdown, { name: "sample.md" });
    await new Promise((r) => setTimeout(r, 300));
    await api.commitStagedImport();
    await new Promise((r) => setTimeout(r, 600));
  }],
  ["flip the card", async (api) => { api.flipCard(); await new Promise((r) => setTimeout(r, 250)); }],
  ["next card", async (api) => { api.navigateCard(1); await new Promise((r) => setTimeout(r, 350)); }],
  ["mark it known", async (api) => { api.moveCard("known"); await new Promise((r) => setTimeout(r, 350)); }],
  ["previous card", async (api) => { api.navigateCard(-1); await new Promise((r) => setTimeout(r, 350)); }],
  ["open All Cards", async (api) => { await api.openAllCardsPanel(); await new Promise((r) => setTimeout(r, 700)); }],
  ["show every answer", async (api) => { await api.setAllCardsAnswersVisible(true); await new Promise((r) => setTimeout(r, 400)); }],
  ["close All Cards", async (api) => { api.closeAllCardsPanel(); await new Promise((r) => setTimeout(r, 250)); }],
  ["switch to notes", async (api) => { api.setViewMode("notes"); await new Promise((r) => setTimeout(r, 600)); }],
  ["type a note", async (api) => {
    api.state.notes = "# My notes\n\nA paragraph with $x^2$ and a {{cloze}}.\n\n- one\n- two\n";
    api.renderNotesView();
    await new Promise((r) => setTimeout(r, 700));
  }],
  ["add a card from the notes", async (api) => {
    api.addCardFromNotes("From notes?", "Yes.");
    await new Promise((r) => setTimeout(r, 400));
  }],
  ["back to cards", async (api) => { api.setViewMode("cards"); await new Promise((r) => setTimeout(r, 500)); }],
  ["shuffle", async (api) => { api.shuffleCards(); await new Promise((r) => setTimeout(r, 400)); }],
  ["export markdown", async (api) => {
    window.__exported = api.exportMarkdown("all");
    await new Promise((r) => setTimeout(r, 250));
  }],
  ["open My Decks", async (api) => { api.openMyDecksPanel(); await new Promise((r) => setTimeout(r, 800)); }],
  ["close My Decks", async (api) => { api.closeMyDecksPanel(); await new Promise((r) => setTimeout(r, 250)); }],
  ["sync", async (api) => { await api.reconcileAllDecks({ explicit: true }); await new Promise((r) => setTimeout(r, 900)); }]
]`;

async function drive(url, apiSrc, shotPrefix) {
  const browser = await puppeteer.launch({ headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    for (const lib of VENDORED) if (existsSync(lib)) await page.evaluateOnNewDocument(readFileSync(lib, "utf8"));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 })
      .catch(() => {});

    const transcript = [];
    const names = await page.evaluate((stepsSrc) => (0, eval)("(" + stepsSrc + ")").map((s) => s[0]), STEPS);
    for (let i = 0; i < names.length; i++) {
      const entry = await page.evaluate(async (stepsSrc, apiS, fakeSrc, snapSrc, idx) => {
        if (!window.__api) {
          try { window.__api = await (0, eval)(apiS)(); }
          catch (e) { return { error: "could not build the api surface: " + e.message, state: {} }; }
        }
        if (!window.__api) return { error: "the api surface is undefined (did the probe script throw?)", state: {} };
        window.__api.__fake ||= (0, eval)("(" + fakeSrc + ")")();
        const steps = (0, eval)("(" + stepsSrc + ")");
        let error = null;
        try { await steps[idx][1](window.__api); }
        catch (e) { error = String(e && e.message).slice(0, 200); }
        return { error, state: (0, eval)("(" + snapSrc + ")")() };
      }, STEPS, apiSrc, FAKE, SNAPSHOT, i);
      transcript.push({ step: names[i], ...entry });
      if (shotPrefix) await page.screenshot({ path: `${shotPrefix}-${String(i).padStart(2, "0")}.png` });
    }
    const exported = await page.evaluate(() => String(window.__exported || "").slice(0, 400));
    return { transcript, errors, exported };
  } finally {
    await browser.close();
  }
}

const MODULE_API = `async () => {
  // ?v=__BUILD__ on every import: a module's URL is its identity, and the
  // unstamped one is a second instance with its own state.
  const mods = await Promise.all([
    import("/src/cloud/supabase-client.js?v=__BUILD__"), import("/src/boot.js?v=__BUILD__"),
    import("/src/ui/boot-screens.js?v=__BUILD__"), import("/src/import/staging.js?v=__BUILD__"),
    import("/src/import/sample.js?v=__BUILD__"), import("/src/cards/deck-actions.js?v=__BUILD__"),
    import("/src/cards/all-cards.js?v=__BUILD__"), import("/src/cards/all-cards-edit.js?v=__BUILD__"),
    import("/src/ui/view-mode.js?v=__BUILD__"),
    import("/src/notes/notes-view.js?v=__BUILD__"), import("/src/notes/anchors.js?v=__BUILD__"),
    import("/src/export/markdown.js?v=__BUILD__"), import("/src/export/pdf.js?v=__BUILD__"),
    import("/src/ui/deck-header.js?v=__BUILD__"),
    import("/src/sync/reconcile.js?v=__BUILD__"), import("/src/core/state.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// NOT setSupabaseClient/setSignedIn: those are module-era setters that do not
// exist in the pre-split build, and naming them here made probe.js throw a
// ReferenceError, leaving window.__recallApi undefined. They are added below as
// closures over the script's own bindings instead.
const NAMES = ["showAuthenticatedUI", "initAppForUser",
  "stageMarkdownImport", "commitStagedImport", "sampleMarkdown", "flipCard", "navigateCard",
  "moveCard", "openAllCardsPanel", "setAllCardsAnswersVisible", "closeAllCardsPanel",
  "setViewMode", "renderNotesView", "addCardFromNotes", "shuffleCards", "exportMarkdown",
  "openMyDecksPanel", "closeMyDecksPanel", "reconcileAllDecks", "state"];

const servers = [];
const temps = [];
let failures = 0;
try {
  const baseDir = mkdtempSync(path.join(tmpdir(), "recall-ui-"));
  temps.push(baseDir);
  execFileSync("bash", ["-c", `git archive ${BASE_REF} | tar -x -C ${baseDir}`], { cwd: ROOT });
  writeFileSync(path.join(baseDir, "probe.js"),
    `window.__recallApi = (function () {\n${readFileSync(path.join(baseDir, "app.js"), "utf8")}\n;return {\n` +
    NAMES.map((n) => `  ${n},`).join("\n") +
    `\n  setSupabaseClient: (c) => { supabaseClient = c; },\n  setSignedIn: (v) => { isSignedIn = v; }\n};\n})();\n`);
  writeFileSync(path.join(baseDir, "index.html"),
    readFileSync(path.join(baseDir, "index.html"), "utf8")
      .replace('<script src="app.js?v=__BUILD__"></script>', '<script src="probe.js"></script>'));

  const sBase = await serveOn(baseDir); servers.push(sBase.proc);
  const sNow = await serveOn(ROOT); servers.push(sNow.proc);
  await new Promise((r) => setTimeout(r, 1200));

  const before = await drive(`${sBase.base}/index.html`, "async () => window.__recallApi", null);
  const after = await drive(`${sNow.base}/index.html`, MODULE_API, SHOT ? "/tmp/ui" : null);

  console.log("── driving the app, vs " + BASE_REF + " ──");
  for (let i = 0; i < after.transcript.length; i++) {
    const a = before.transcript[i], b = after.transcript[i];
    const sameState = JSON.stringify(a?.state) === JSON.stringify(b?.state);
    const sameError = String(a?.error) === String(b?.error);
    const ok = sameState && sameError && !b?.error;
    console.log(`  ${ok ? "ok  " : (sameState && sameError ? "both" : "DIFF")}  ${b.step}${b.error ? " — threw: " + b.error : ""}`);
    if (!sameState) {
      failures++;
      console.log(`        was: ${JSON.stringify(a?.state)}`);
      console.log(`        now: ${JSON.stringify(b?.state)}`);
    } else if (b?.error) {
      failures++;   // identical failure on both builds is still a broken step
    }
  }

  const sameExport = before.exported === after.exported;
  console.log(`\n  ${sameExport ? "ok  " : "DIFF"}  the exported markdown is identical`);
  if (!sameExport) {
    failures++;
    console.log(`        was: ${JSON.stringify(before.exported.slice(0, 200))}`);
    console.log(`        now: ${JSON.stringify(after.exported.slice(0, 200))}`);
  }
  const ours = (m) => !/cdn\.jsdelivr|supabase|Failed to load resource|net::ERR_/i.test(m);
  const realErrors = after.errors.filter(ours);
  if (realErrors.length) { failures += realErrors.length; console.log(`\n  page errors: ${realErrors.slice(0, 4).join(" | ")}`); }

  console.log(failures ? `\n${failures} UI problem(s).` : `\n${after.transcript.length} actions driven: identical on both builds, no errors.`);
} finally {
  for (const s of servers) s.kill();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
