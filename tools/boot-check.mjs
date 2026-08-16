// Load the app in a real browser and report anything the console says.
//
//   node tools/boot-check.mjs                          # serves . on a free port
//   node tools/boot-check.mjs http://localhost:5500/   # or point it somewhere
//   node tools/boot-check.mjs --baseline main          # …and diff against a ref
//
// The static checks (split-parity, module-symbols) prove the code is intact and
// the imports resolve. They cannot prove the app still RUNS, and the module
// switch broke it twice in ways no amount of reading would have caught:
//
//   - a duplicate `fetchText`, legal in a classic script, is a hard SyntaxError
//     in a module — the whole file failed to parse and nothing ran;
//   - `readyState === "loading"` is false for a deferred module script, so an
//     initialiser fired mid-file and hit a temporal-dead-zone const.
//
// Both showed up on the first page load and neither is visible statically. So
// this runs after every extraction.
//
// It reports a state object rather than a screenshot because the useful question
// is "is this the same as before the change", and that is a diff. --baseline
// checks out a git ref into a temp dir, boots that too, and compares.
//
// Needs a Chrome and a puppeteer. It looks for puppeteer in the usual global
// spots; if there is none, it says so and exits 0 rather than failing a run that
// is otherwise fine.

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// State keys that are ALLOWED to differ from the baseline, and why. Keep this
// short, like split-parity's ACCEPTED — every entry is a place where "boots the
// same as it always did" was deliberately spent.
const ACCEPTED_DIFFS = {
  toolbarsFilled:
    "15/15/11 -> 3/3/3. The raw-edit toolbars keep only the three controls a " +
    "SELECTION cannot express (insert image, bullet, clear formatting). " +
    "Everything else on them — B I U S </>, font, colour, highlight, and the " +
    "capture group — moved to the floating selection pill, which now works in " +
    "raw mode too (applyRenderFormat's editing branch). They refused without a " +
    "selection, so as permanent strips they could do nothing until you made " +
    "one, while covering the text. The All Cards editor still builds the full " +
    "strip and is not counted here.",
  renderToolbars:
    "3 -> 1. The card faces' two persistent .render-toolbar strips are gone " +
    "for the same reason the notes one already was; the one that remains is " +
    "#selectionFloatFormat, the formatting slot inside the pill.",
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const baselineIdx = args.indexOf("--baseline");
const baselineRef = baselineIdx !== -1 ? args[baselineIdx + 1] : null;
const explicitUrl = args.find((a) => a.startsWith("http"));

const CHROME = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"
].find(existsSync);

function loadPuppeteer() {
  const candidates = [
    ROOT,
    "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/",
    "/usr/lib/node_modules/@mermaid-js/mermaid-cli/"
  ];
  for (const base of candidates) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}

const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) {
  console.log("boot-check: no puppeteer and/or Chrome found — skipping.");
  console.log("            (npm i -D puppeteer, or install Chrome, to enable it)");
  process.exit(0);
}

// A tiny static server on a FREE port, so this works with no dev server running
// and cannot be answered by one left behind from an interrupted run.
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

// The clipper vendors these, so the check needs no network.
const VENDORED = [
  path.join(ROOT, "recall-clipper/vendor/marked.min.js"),
  path.join(ROOT, "recall-clipper/vendor/purify.min.js")
];

async function boot(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage();
    // Cut the CDN off deliberately, on BOTH pages, and hand the two libraries
    // the app cannot start without straight to the page from the copies the
    // clipper vendors.
    //
    // Left to the network this check was flaky in a way that had nothing to do
    // with the code: sometimes jsdelivr answered, sometimes it returned
    // ERR_CERT_VERIFIER_CHANGED or ERR_CONNECTION_CLOSED, and a run where the
    // baseline got its libraries and the current tree did not reported a
    // difference that was entirely the network's. Cutting it off makes both
    // sides identical and the result reproducible.
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    // BEFORE any of the page's own scripts: main.js reaches for `marked` during
    // module evaluation, so a <script> added after navigation is far too late.
    for (const lib of VENDORED) {
      if (existsSync(lib)) await page.evaluateOnNewDocument(readFileSync(lib, "utf8"));
    }
    const logs = [];
    page.on("console", (m) => logs.push([m.type(), m.text()]));
    page.on("pageerror", (e) => logs.push(["PAGEERROR", `${e.message}\n${e.stack || ""}`]));
    page.on("requestfailed", (r) => logs.push(["REQFAIL", `${r.url()} — ${r.failure()?.errorText}`]));

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    // WAIT for the boot to finish rather than sleeping and hoping. index.html
    // marks <html class="app-booting"> and the last statement of main.js clears
    // it, so this is precisely "the module graph evaluated to its end".
    //
    // A fixed 2.5s sleep after networkidle2 was flaky at 130 modules with the
    // CDN failing slowly: often enough the sample landed mid-boot and reported
    // a perfectly healthy page as broken. A timing check that fails at random
    // is worse than no check, because it teaches you to re-run until green.
    let bootTimedOut = false;
    try {
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("app-booting"),
        { timeout: 30000 }
      );
    } catch (_) {
      bootTimedOut = true;
    }
    await new Promise((r) => setTimeout(r, 500));

    // Observable proof that the module evaluated to its LAST line and that the
    // deferred initialisers ran — not merely that nothing threw.
    const state = await page.evaluate(() => ({
      // set by index.html's boot-click queue, cleared only by the replay IIFE
      // at the very bottom of main.js
      bootQueueDrained: !document.documentElement.classList.contains("app-booting"),
      setupVisible: !document.getElementById("setupScreen")?.hasAttribute("hidden"),
      toolbarButtons: document.querySelectorAll("#mainToolbar button").length,
      // initToolbars(): fills these from createToolbarHtml, then runs
      // enableSyntaxHighlighting, which builds one mirror backdrop per editor
      toolbarsFilled: ["questionEditToolbar", "answerEditToolbar", "notesEditToolbar"]
        .map((id) => `${id}:${document.getElementById(id)?.children.length ?? "missing"}`).join(" "),
      highlightBackdrops: document.querySelectorAll("[class*=backdrop]").length,
      renderToolbars: document.querySelectorAll("[class*=render-toolbar]").length,
      bodyText: (document.body.innerText || "").slice(0, 120).replace(/\s+/g, " ")
    }));
    return { state, logs, bootTimedOut };
  } finally {
    await browser.close();
  }
}

// Anything from the CDN or Supabase is the environment having no network or no
// credentials, not a defect in the page. Chrome reports those twice: once as a
// REQFAIL carrying the URL, and once as a bare console error that does NOT —
// "Failed to load resource: net::ERR_CERT_VERIFIER_CHANGED" names nothing at
// all. Filtering only on the URL let the second form through and failed a run
// whose page state was identical to the baseline's.
const NETWORK_NOISE = /cdn\.jsdelivr|supabase|favicon|Failed to load resource|net::ERR_/i;
const isOurs = ([type, msg]) =>
  (type === "PAGEERROR" || type === "error" || type === "REQFAIL") && !NETWORK_NOISE.test(msg);

const servers = [];
const temps = [];
try {
  let url = explicitUrl;
  if (!url) { const s0 = await serveOn(ROOT); servers.push(s0.proc); url = `${s0.base}/index.html`; }

  let baseline = null;
  if (baselineRef) {
    const dir = mkdtempSync(path.join(tmpdir(), "recall-baseline-"));
    temps.push(dir);
    execFileSync("bash", ["-c", `git archive ${baselineRef} | tar -x -C ${dir}`], { cwd: ROOT });
    const s1 = await serveOn(dir);
    servers.push(s1.proc);
    baseline = `${s1.base}/index.html`;
  }
  await new Promise((r) => setTimeout(r, 1500));

  const now = await boot(url);
  const problems = now.logs.filter(isOurs);
  if (now.bootTimedOut) problems.push(["BOOT", "the app never finished booting (app-booting never cleared)"]);

  console.log("── console ──");
  if (!now.logs.length) console.log("  (silent)");
  for (const [t, m] of now.logs) console.log(`  [${t}] ${m.slice(0, 400)}`);
  console.log("── state ──");
  for (const [k, v] of Object.entries(now.state)) console.log(`  ${k}: ${v}`);

  if (baseline) {
    const before = await boot(baseline);
    const changed = Object.keys(now.state).filter((k) => String(before.state[k]) !== String(now.state[k]));
    const fmt = (k) => `  ${k}\n    ${baselineRef}: ${before.state[k]}\n    now: ${now.state[k]}`;
    const diffs = changed.filter((k) => !(k in ACCEPTED_DIFFS)).map(fmt);
    const accepted = changed.filter((k) => k in ACCEPTED_DIFFS).map((k) => `${fmt(k)}\n    why: ${ACCEPTED_DIFFS[k]}`);
    console.log(`\n── vs ${baselineRef} ──`);
    console.log(diffs.length ? diffs.join("\n") : "  identical");
    if (accepted.length) console.log(`\n── accepted differences ──\n${accepted.join("\n")}`);
    if (diffs.length) problems.push(["DIFF", "state differs from the baseline"]);
  }

  console.log(`\n${problems.length} problem(s)`);
  process.exitCode = problems.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
