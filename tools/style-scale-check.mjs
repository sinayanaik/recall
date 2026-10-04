// Does pressing a button cost the same on a big note as on a small one?
//
//   node tools/style-scale-check.mjs
//
// Reported as "the snappiness and button responsiveness everything is degrading
// with the increasing size of the note", on phones and on desktop. It was not
// JavaScript. It was style recalculation: CSS :has() rules whose answer the
// browser must re-check whenever anything under their anchor changes, anchored
// on #notesView itself or on one of its ancestors (<html>, <body>, .app-shell,
// .quiz-panel, .notes-stage). A menu opening, a button hidden, a node inserted
// by a highlight — each re-styled the whole open note. Measured on a desktop,
// unthrottled, on the fixture below (1,500 paragraphs, six annotated highlights
// each):
//
//                                   before    after
//   ☰ menu opening                  421ms     ~1ms
//   a [hidden] flipped elsewhere    410ms     ~1ms
//   a node inserted in a highlight  1,036ms   ~10ms
//
// A phone (4x CPU throttle) was 2.8s, 2.7s and 6s. Most of it came from two
// rules in styles/75-highlight-stability.css — a :has(> :nth-child(60)) that
// was quadratic in the note, and a per-block :has(.hl-note-badge) that also
// switched containment off for every annotated block — and the rest from the
// ancestor-anchored :has() rules src/ui/chrome.js now mirrors into classes
// (syncChromeState). See the notes at the top of 75-highlight-stability.css
// and 33-reading-chrome.css.
//
// So this asserts three things:
//   • statically, that no stylesheet outside the frozen slices anchors a :has()
//     on #notesView or an ancestor of it (the frozen 01-13 slices still carry
//     some; tools/split-css.mjs keeps them byte-for-byte, so they are counted
//     in the budgets rather than fixed);
//   • in a real browser, that each of those three interactions costs a few
//     milliseconds of style and layout on the big note — the mirror's own
//     observer included, since the press is not over until it has run;
//   • that what the replaced rules DID still happens: a short note is
//     uncontained, a long one is contained with a widened clip edge, and the
//     mirrored classes follow the facts they copy.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = findChrome();

const results = [];
const push = (name, detail, measured = "") => results.push({ name, ok: detail === true, detail: detail === true ? "" : String(detail), measured });

// ── Static: no :has() anchored on the note or above it ─────────────────────
//
// The anchor is the compound right before `:has(`. A frozen slice is any
// NN-*.css with NN ≤ 13 (tools/split-css.mjs SECTIONS).
const ANCHORS = /(^|[\s>+~(,])(html|body|:root)\b|\.app-shell\b|\.quiz-panel\b|\.notes-stage\b|#notesView\b/;
{
  const offenders = [];
  for (const file of readdirSync(path.join(ROOT, "styles")).sort()) {
    const m = /^(\d+)-.*\.css$/.exec(file);
    if (!m || Number(m[1]) <= 13) continue;
    const text = readFileSync(path.join(ROOT, "styles", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    text.split("\n").forEach((line, i) => {
      let at = line.indexOf(":has(");
      while (at !== -1) {
        // Walk back over the compound the :has() is attached to.
        let start = at;
        while (start > 0 && !/[\s>+~,{}]/.test(line[start - 1])) start -= 1;
        const compound = line.slice(start, at);
        if (ANCHORS.test(` ${compound}`)) offenders.push(`styles/${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
        at = line.indexOf(":has(", at + 5);
      }
    });
  }
  push("no post-split stylesheet anchors a :has() on #notesView or an ancestor of it",
    offenders.length ? `${offenders.length} found:\n        ${offenders.join("\n        ")}` : true);
}

if (!CHROME) {
  console.error("style-scale-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"], { stdio: ["ignore", "pipe", "ignore"] });
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

// Desktop, unthrottled. Generous against today's numbers (above) and well under
// what any one of the replaced rules costs on its own coming back (15ms per
// press for the ancestor rules, 137-180ms for each of the 75 ones).
const BUDGET = { toggleMs: 8, insertMs: 40 };
const PARAS = 1500;
const MARKS = 6;

const SETUP = `async () => {
  const paths = ["/src/notes/notes-view.js?v=__BUILD__", "/src/render/block-cache.js?v=__BUILD__", "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__", "/src/cloud/supabase-client.js?v=__BUILD__", "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__", "/src/core/state.js?v=__BUILD__"];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("style-scale-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Style scale fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);
  window.__scale = { api, settle };
  return true;
}`;

// A note of \`paras\` paragraphs, each with \`marks\` highlights that carry a note
// (the legacy inline form, so no "## Highlight Notes" section is needed).
const RENDER = `async ({ paras, marks }) => {
  const { api, settle } = window.__scale;
  const enc = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const out = [];
  for (let p = 0; p < paras; p += 1) {
    if (p % 50 === 0) out.push("## Section " + p + "\\n");
    let line = "";
    for (let m = 0; m < marks; m += 1) {
      line += "word" + p + "x" + m + ' <mark data-color="yellow" data-note="' + enc("note " + p + "/" + m) + '">gloss' + p + "y" + m + "</mark> ";
    }
    out.push(line + "end of paragraph " + p + ".\\n");
  }
  api.state.notes = out.join("\\n");
  api.setNotesScrolledSource(null);
  api.invalidateRenderedBlockCache();
  await api.renderNotesView();
  await settle(1200);
  const view = document.getElementById("notesView");
  const block = view.querySelector(":scope > p");
  const cs = block ? getComputedStyle(block) : null;
  return {
    children: view.children.length,
    badges: view.querySelectorAll(".hl-note-badge").length,
    short: view.classList.contains("is-short-note"),
    contentVisibility: cs ? cs.contentVisibility : "",
    clipMargin: cs ? parseFloat(cs.overflowClipMargin) || 0 : 0
  };
}`;

// Each sample: the change, the microtasks it queues (the chrome-state mirror is
// a MutationObserver), then a forced style + layout. The median of 15.
const MEASURE = `async () => {
  const view = document.getElementById("notesView");
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const sample = async (change, n = 15) => {
    const xs = [];
    for (let i = 0; i < n; i += 1) {
      const t0 = performance.now();
      change(i);
      await flush();
      void view.offsetHeight;
      getComputedStyle(view.firstElementChild).color;
      xs.push(performance.now() - t0);
    }
    xs.sort((a, b) => a - b);
    return xs[Math.floor(n / 2)];
  };
  const toolbar = document.getElementById("mainToolbar");
  const menu = await sample((i) => toolbar.classList.toggle("mobile-open", i % 2 === 0));
  toolbar.classList.remove("mobile-open");
  const stray = document.createElement("div");
  document.body.appendChild(stray);
  const hidden = await sample((i) => { stray.hidden = i % 2 === 0; });
  stray.remove();
  const mark = view.querySelector("mark");
  const insert = await sample(() => { const s = document.createElement("span"); mark.appendChild(s); void view.offsetHeight; s.remove(); });
  await flush();
  return { menu, hidden, insert };
}`;

// The mirror follows what it copies, within the same turn of the event loop.
const MIRROR = `async () => {
  const body = document.body;
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  const out = {};
  const toolbar = document.getElementById("mainToolbar");
  toolbar.classList.add("mobile-open"); await flush();
  out.menuOpen = body.classList.contains("cs-menu-open");
  toolbar.classList.remove("mobile-open"); await flush();
  out.menuClosed = !body.classList.contains("cs-menu-open");
  out.notesMode = body.classList.contains("cs-notes-mode") === document.querySelector(".quiz-panel").classList.contains("notes-mode");
  const toggle = document.getElementById("viewModeToggle");
  out.viewToggle = body.classList.contains("cs-view-toggle") === !toggle.hidden;
  const notesEdit = document.getElementById("notesEdit");
  const wasHidden = notesEdit.hidden;
  notesEdit.hidden = false; await flush();
  out.editing = body.classList.contains("cs-notes-editing");
  notesEdit.hidden = wasHidden; await flush();
  out.notEditing = body.classList.contains("cs-notes-editing") === !wasHidden;
  const stage = document.getElementById("documentStage");
  const stageHidden = stage.hidden;
  stage.hidden = false; await flush();
  out.docShown = body.classList.contains("cs-doc-shown");
  stage.hidden = stageHidden; await flush();
  out.docHidden = body.classList.contains("cs-doc-shown") === !stageHidden;
  return out;
}`;

const servers = [];
let failed = 0;
try {
  const server = await serveOn(ROOT);
  servers.push(server.proc);
  const browser = await launch({ executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2000));
    await page.evaluate((src) => (0, eval)("(" + src + ")")(), SETUP);

    // ── A short note: no containment, by class ─────────────────────────────
    const small = await page.evaluate((src, a) => (0, eval)("(" + src + ")")(a), RENDER, { paras: 30, marks: 2 });
    push("a short note carries is-short-note", small.short ? true : `#notesView has ${small.children} children and no is-short-note`);
    push("...and its blocks are not contained", small.contentVisibility === "visible" ? true : `content-visibility is ${small.contentVisibility}`);

    // ── The big annotated note ─────────────────────────────────────────────
    const big = await page.evaluate((src, a) => (0, eval)("(" + src + ")")(a), RENDER, { paras: PARAS, marks: MARKS });
    push("the fixture is a large annotated note", big.children >= 1000 && big.badges >= 1000 ? true : `${big.children} blocks, ${big.badges} folds`,
      `${big.children} blocks, ${big.badges} folds`);
    push("a long note is not marked short", big.short ? "is-short-note on a " + big.children + "-block note" : true);
    push("...keeps its blocks contained, folds and all", big.contentVisibility === "auto" ? true : `content-visibility is ${big.contentVisibility}`);
    push("...with a clip edge wide enough for a fold's target", big.clipMargin >= 4 ? true : `overflow-clip-margin is ${big.clipMargin}px`, `${big.clipMargin}px`);

    const m = await page.evaluate((src) => (0, eval)("(" + src + ")")(), MEASURE);
    const ms = (v) => `${v.toFixed(1)}ms`;
    push("opening the ☰ menu does not re-style the note", m.menu <= BUDGET.toggleMs ? true : `${ms(m.menu)} (budget ${BUDGET.toggleMs}ms)`, ms(m.menu));
    push("hiding an unrelated element does not re-style the note", m.hidden <= BUDGET.toggleMs ? true : `${ms(m.hidden)} (budget ${BUDGET.toggleMs}ms)`, ms(m.hidden));
    push("inserting a node in a highlight stays local", m.insert <= BUDGET.insertMs ? true : `${ms(m.insert)} (budget ${BUDGET.insertMs}ms)`, ms(m.insert));

    const mirror = await page.evaluate((src) => (0, eval)("(" + src + ")")(), MIRROR);
    for (const [k, v] of Object.entries(mirror)) push(`chrome-state mirror: ${k}`, v ? true : "the body class does not match");
  } finally {
    await browser.close();
  }
  const real = errors.filter((e) => !/marked is not defined|renderMathInElement/.test(e));
  real.slice(0, 5).forEach((e) => push("no uncaught page error", e.split("\n")[0]));
} catch (error) {
  push("the check ran", String(error?.message || error).split("\n")[0]);
} finally {
  for (const s of servers) s.kill();
}

for (const r of results) {
  if (!r.ok) failed += 1;
  const tail = r.ok ? (r.measured ? `  ·  ${r.measured}` : "") : `\n        ${r.detail}`;
  console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${tail}`);
}
console.log(`\nCHECK: ${results.length} checks · ${failed} failed`);
process.exitCode = failed ? 1 : 0;
