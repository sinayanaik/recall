// Section lines in Notes: each heading's section a step in, with a thin line
// down it (src/notes/section-lines.js, styles/a5-section-lines.css).
//
//   node tools/section-lines-check.mjs
//   SHOT=/some/dir node tools/section-lines-check.mjs   # also saves screenshots
//
// The lines are paint — a block's own border-image — so the only way to know
// one is unbroken is to look: this takes a screenshot and walks a column of
// pixels down each line, across the gaps between paragraphs, which is exactly
// where the obvious way to draw them (a ::before, clipped by every block's
// paint containment) fell apart into a dash per paragraph.
//
// Also: the depths (a lone title stays out), the step, the borders that the
// border-image would otherwise have taken off a code block, a quote and a
// rule, a click on a line folding its section, the setting turning it all
// off, the paged layout left alone — and the lead-in line of a list sitting as
// close to it as its bullets (styles/a6-list-lead.css).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = findChrome();
const SHOT = process.env.SHOT || "";
// A narrower window for a look at the phone layout: WIDTH=390.
const WIDTH = Number(process.env.WIDTH) || 1100;

if (!CHROME) {
  console.error("section-lines-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

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

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/notes/paged-view.js?v=__BUILD__"),
    import("/src/notes/notes-view.js?v=__BUILD__"),
    import("/src/render/block-cache.js?v=__BUILD__"),
    import("/src/ui/view-mode.js?v=__BUILD__"),
    import("/src/ui/boot-screens.js?v=__BUILD__"),
    import("/src/cloud/supabase-client.js?v=__BUILD__"),
    import("/src/cards/new-deck.js?v=__BUILD__"),
    import("/src/boot.js?v=__BUILD__"),
    import("/src/notes/section-lines.js?v=__BUILD__"),
    import("/src/core/state.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const NOTE = [
  "# The title",
  "",
  "An opening paragraph, before any section.",
  "",
  "## Methods",
  "",
  "The things to check:",
  "- the first thing",
  "- the second thing",
  "",
  "### Setup",
  "",
  "A paragraph about the setup, long enough to take a line or two of the column at this width so the gap below it is a real one.",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  "> A quoted remark in the setup.",
  "",
  "---",
  "",
  "Another paragraph after the rule.",
  "",
  "### Run",
  "",
  "A paragraph about the run.",
  "",
  "## Results",
  "",
  "A paragraph of results."
].join("\\n");

// Runs INSIDE the page: open a note, render it, report what can be read off
// the DOM, and where each line is for the pixel walk.
const SETUP = `async (api) => {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const view = document.getElementById("notesView");
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("section-lines-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Section lines fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(400);
  api.commitNotesEditIfActive();
  await settle(400);
  if (!(view.clientWidth > 200)) return { error: "#notesView is " + view.clientWidth + "px wide" };
  api.state.notes = "${NOTE}";
  await api.renderNotesView();
  await settle(700);
  const blocks = api.notesTopLevelBlocks(view);
  const rows = blocks.map((b) => {
    const r = b.getBoundingClientRect();
    return { tag: b.tagName, text: (b.textContent || "").replace(/^[^A-Za-z]+/, "").trim().slice(0, 40), depth: Number(b.dataset.outlineDepth) || 0, left: r.left, top: r.top, bottom: r.bottom };
  });
  const cs = getComputedStyle(view);
  const px = (name) => parseFloat(cs.getPropertyValue(name)) || 0;
  const pre = view.querySelector(":scope > pre");
  const quote = view.querySelector(":scope > blockquote");
  const rule = view.querySelector(":scope > hr");
  const lead = [...view.querySelectorAll(":scope > p")].find((p) => p.textContent.startsWith("The things"));
  const list = lead?.nextElementSibling;
  return {
    rows,
    step: px("--ol-step"),
    offset: px("--ol-offset"),
    width: px("--ol-width"),
    fontSize: parseFloat(cs.fontSize),
    on: document.documentElement.classList.contains("notes-outline"),
    preOutline: pre ? getComputedStyle(pre).outlineStyle + " " + getComputedStyle(pre).outlineWidth : "none",
    quoteShadow: quote ? getComputedStyle(quote).boxShadow : "none",
    ruleBackground: rule ? getComputedStyle(rule).backgroundColor : "none",
    ruleHeight: rule ? rule.getBoundingClientRect().height : 0,
    leadGap: lead && list ? list.getBoundingClientRect().top - lead.getBoundingClientRect().bottom : null,
    dpr: window.devicePixelRatio
  };
}`;

// Pixel walk, inside the page, over a screenshot passed in as base64: for each
// x, the runs of rows that differ from the paper.
const PIXELS = `async (b64, probes) => {
  const img = new Image();
  img.src = "data:image/png;base64," + b64;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  // Screenshot pixels per CSS pixel (2 when SHOT asks for a sharp one).
  const k = img.width / window.innerWidth;
  return probes.map(({ x: cssX, y0: cssY0, y1: cssY1, bg }) => {
    const x = cssX * k; const y0 = cssY0 * k; const y1 = cssY1 * k;
    // Three columns either side of where the line should be: a 1px line at a
    // fractional x is shared between two device pixels, half as dark in each.
    const cols = [-1, 0, 1].map((dx) => g.getImageData(Math.round(x) + dx, 0, 1, img.height).data);
    let inked = 0; let total = 0; let firstGap = null; let run = 0; let longestGap = 0;
    for (let y = Math.round(y0); y < Math.round(y1); y += 1) {
      const i = y * 4;
      const d = Math.max(...cols.map((col) => Math.abs(col[i] - bg[0]) + Math.abs(col[i + 1] - bg[1]) + Math.abs(col[i + 2] - bg[2])));
      total += 1;
      if (d > 12) { inked += 1; run = 0; } else {
        if (firstGap === null) firstGap = y;
        run += 1;
        longestGap = Math.max(longestGap, run);
      }
    }
    return { x, inked, total, firstGap, longestGap };
  });
}`;

const AFTER = `async (api) => {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const view = document.getElementById("notesView");
  const out = {};
  const blocks = () => api.notesTopLevelBlocks(view);
  const find = (t) => blocks().find((b) => (b.textContent || "").replace(/^[^A-Za-z]+/, "").trim().startsWith(t));
  const cs = getComputedStyle(view);
  const step = parseFloat(cs.getPropertyValue("--ol-step"));
  const offset = parseFloat(cs.getPropertyValue("--ol-offset"));
  const width = parseFloat(cs.getPropertyValue("--ol-width")) || 1;
  // Click on the first line beside "A paragraph about the run." — line 0 is
  // the Methods section's, so Methods folds.
  const run = find("A paragraph about the run");
  const r = run.getBoundingClientRect();
  const depth = Number(run.dataset.outlineDepth);
  const x = r.left - depth * step + offset + width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  out.hitIsView = hit === view || hit?.classList.contains("notes-chunk");
  hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
  await settle(300);
  out.foldedHidden = ["The things", "### never", "A paragraph about the setup", "A paragraph about the run"]
    .map((t) => find(t)).filter(Boolean).every((b) => b.hidden);
  out.resultsShown = !find("A paragraph of results").hidden;
  out.methodsShown = !find("Methods").hidden;
  // A click on the text of a paragraph folds nothing.
  api.resetNotesFoldedHeadings();
  api.applyNotesFoldState(view);
  await settle(100);
  const results = find("A paragraph of results");
  const rr = results.getBoundingClientRect();
  results.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, clientX: rr.left + 20, clientY: rr.top + rr.height / 2 }));
  await settle(200);
  out.textClickFoldsNothing = !blocks().some((b) => b.hidden);
  // Top level forced to H1: the title is a section too.
  api.setNotesSectionLines({ on: true, top: "h1" });
  api.applyNotesFoldState(view);
  out.h1Depths = blocks().map((b) => Number(b.dataset.outlineDepth) || 0);
  // Off: no depth, no step, no lines.
  api.setNotesSectionLines({ on: false, top: "auto" });
  api.applyNotesFoldState(view);
  await settle(100);
  out.offAttrs = blocks().filter((b) => b.dataset.outlineDepth !== undefined).length;
  const lefts = blocks().filter((b) => !b.hidden).map((b) => Math.round(b.getBoundingClientRect().left));
  out.offLefts = [...new Set(lefts)].length;
  out.offBorderImage = getComputedStyle(find("A paragraph about the run")).borderImageSource;
  out.offClass = document.documentElement.classList.contains("notes-outline");
  // On again, then the paged layout: no steps there.
  api.setNotesSectionLines({ on: true, top: "auto" });
  api.applyNotesFoldState(view);
  api.setNotesReadingMode("paged-1");
  await settle(500);
  const pagedLefts = blocks().map((b) => b.getBoundingClientRect()).filter((b) => b.width).map((b) => Math.round(b.left));
  out.pagedDistinctLefts = [...new Set(pagedLefts)].length;
  api.setNotesReadingMode("continuous");
  await settle(400);
  return out;
}`;

async function run(base, errors) {
  const browser = await launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", `--window-size=${WIDTH},1300`]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: 1300, deviceScaleFactor: SHOT ? 2 : 1 });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    for (const lib of [
      "recall-clipper/vendor/marked.min.js", "recall-clipper/vendor/purify.min.js",
      "recall-clipper/vendor/katex/katex.min.js", "recall-clipper/vendor/katex/auto-render.min.js"
    ]) {
      const full = path.join(ROOT, lib);
      if (existsSync(full)) await page.evaluateOnNewDocument(readFileSync(full, "utf8"));
    }
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
    await new Promise((r) => setTimeout(r, 2500));
    const runProbe = (src) => page.evaluate(async (probeSrc, apiSrc) => {
      const api = await (0, eval)(apiSrc)();
      return await (0, eval)("(" + probeSrc + ")")(api);
    }, src, API_SRC);

    const setup = await runProbe(SETUP);
    if (setup.error) return { setup };
    if (SHOT) { mkdirSync(SHOT, { recursive: true }); }
    const png = await page.screenshot(SHOT ? { path: path.join(SHOT, "section-lines.png") } : {});
    // The paper's colour, from a point in the margin left of every line.
    const paperAt = await page.evaluate(() => {
      const v = document.getElementById("notesView").getBoundingClientRect();
      return { x: v.left + 3, y: v.bottom - 6 };
    });
    const sample = await page.evaluate(async (b64, p) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const k = img.width / window.innerWidth;
      return Array.from(g.getImageData(Math.round(p.x * k), Math.round(p.y * k), 1, 1).data.slice(0, 3));
    }, png.toString("base64"), paperAt);

    // Line 0 (Methods) runs from its first block to "A paragraph about the
    // run" — across the list, a sub-heading, code, a quote and a rule. Line 1
    // (Setup) from its first paragraph to the one after the rule.
    const rows = setup.rows;
    const row = (t) => rows.find((r) => r.text.startsWith(t));
    const first = row("The things");
    const last = row("A paragraph about");
    const runRow = rows.find((r) => r.text.startsWith("A paragraph about the r"));
    const setupFirst = rows.find((r) => r.text.startsWith("A paragraph about the s"));
    const afterRule = row("Another paragraph");
    const colLeft = first.left - first.depth * setup.step;
    const lineX = (k) => colLeft + k * setup.step + setup.offset + setup.width / 2 - 0.5;
    const probes = [
      { name: "line 0 (Methods)", x: lineX(0), y0: first.top + 2, y1: runRow.bottom - 2, bg: sample },
      { name: "line 1 (Setup)", x: lineX(1), y0: setupFirst.top + 2, y1: afterRule.bottom - 2, bg: sample },
      { name: "line 0 (Results)", x: lineX(0), y0: row("A paragraph of").top + 2, y1: row("A paragraph of").bottom - 2, bg: sample },
      // Below the opening paragraph, down to the Methods heading: in no section.
      { name: "no line before the first section", x: lineX(0), y0: row("An opening").bottom + 2, y1: row("Methods").top - 2, bg: sample }
    ];
    const walked = await page.evaluate(async (pixSrc, b64, ps) => (0, eval)("(" + pixSrc + ")")(b64, ps), PIXELS, png.toString("base64"), probes);
    const after = await runProbe(AFTER);
    if (SHOT) await page.screenshot({ path: path.join(SHOT, "section-lines-after.png") });
    return { setup, walked, probes, after, last };
  } finally {
    await browser.close();
  }
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: ok ? "" : detail });

const server = await serveOn(ROOT);
const errors = [];
try {
  const out = await run(server.base, errors);
  const { setup } = out;
  if (setup.error) {
    check("setup", false, setup.error);
  } else {
    const depthOf = (t) => setup.rows.find((r) => r.text.startsWith(t))?.depth;
    const want = {
      "The title": 0, "An opening": 0, "Methods": 0, "The things": 1, "the first": 1,
      "Setup": 1, "A paragraph about the s": 2, "const answer": 2, "A quoted": 2,
      "Another paragraph": 2, "Run": 1, "A paragraph about the r": 2, "Results": 0, "A paragraph of": 1
    };
    const wrong = Object.entries(want).filter(([t, d]) => depthOf(t) !== d).map(([t, d]) => `${t}: ${depthOf(t)} (want ${d})`);
    check("each block's depth is how many sections it is in — the lone title stays out", wrong.length === 0, wrong.join("; ") + " — rows: " + JSON.stringify(setup.rows.map((r) => [r.text, r.depth])));
    check("the setting is on by default", setup.on === true, "no .notes-outline on <html>");
    const left = (t) => setup.rows.find((r) => r.text.startsWith(t)).left;
    const stepOk = Math.abs(left("The things") - left("Methods") - setup.step) <= 1 && Math.abs(left("A paragraph about the s") - left("The things") - setup.step) <= 1;
    check("each depth is set in by one step", setup.step > 4 && stepOk, JSON.stringify({ step: setup.step, methods: left("Methods"), things: left("The things"), setup: left("A paragraph about the s") }));
    const [l0, l1, results0, none] = out.walked;
    check("line 0 runs unbroken down its section, across every gap and block", l0.longestGap === 0, JSON.stringify(l0) + " probe " + JSON.stringify(out.probes[0]));
    check("line 1 runs unbroken beside code, a quote and a rule", l1.longestGap === 0, JSON.stringify(l1));
    check("the next section has its own line", results0.longestGap === 0, JSON.stringify(results0));
    check("text in no section has no line beside it", none.inked / Math.max(1, none.total) < 0.1, JSON.stringify(none));
    check("a code block keeps its frame", /solid 1px/.test(setup.preOutline), setup.preOutline);
    check("a quote keeps its bar", /inset/.test(setup.quoteShadow), setup.quoteShadow);
    check("a rule keeps its line", setup.ruleHeight >= 1 && !/rgba\(0, 0, 0, 0\)/.test(setup.ruleBackground), JSON.stringify({ h: setup.ruleHeight, bg: setup.ruleBackground }));
    const gapEm = setup.leadGap / setup.fontSize;
    check("a lead-in line sits as close to its list as the bullets to each other", setup.leadGap !== null && Math.abs(gapEm - 0.35) < 0.08, `gap ${setup.leadGap}px = ${gapEm.toFixed(2)}em`);
    const a = out.after;
    check("a click on a line lands in the strip beside the text", a.hitIsView, JSON.stringify(a));
    check("...and folds that line's section", a.foldedHidden && a.methodsShown && a.resultsShown, JSON.stringify(a));
    check("a click on the words of a paragraph folds nothing", a.textClickFoldsNothing, JSON.stringify(a));
    const h1 = a.h1Depths;
    check("Top level H1 makes the title a section too", h1[0] === 0 && h1[1] === 1 && h1[2] === 1 && h1[3] === 2, JSON.stringify(h1));
    check("turned off: no depths, no steps, no lines", a.offAttrs === 0 && a.offLefts === 1 && a.offBorderImage === "none" && !a.offClass, JSON.stringify(a));
    check("the paged layout is left as it was", a.pagedDistinctLefts === 1, JSON.stringify(a));
  }
} catch (e) {
  check("the check itself", false, e.stack || String(e));
} finally {
  server.proc.kill();
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.ok ? "" : "\n        " + r.detail}`);
if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
console.log(`\nCHECK: ${results.length} checks · ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
