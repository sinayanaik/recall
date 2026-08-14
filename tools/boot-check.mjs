// Load the app in a real browser and report anything the console says.
//
//   node tools/boot-check.mjs                          # serves . on :8099
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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// A tiny static server, so this works with no dev server running.
function serve(dir, port) {
  const p = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
    { cwd: dir, stdio: "ignore" });
  return p;
}

async function boot(url) {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => logs.push([m.type(), m.text()]));
    page.on("pageerror", (e) => logs.push(["PAGEERROR", `${e.message}\n${e.stack || ""}`]));
    page.on("requestfailed", (r) => logs.push(["REQFAIL", `${r.url()} — ${r.failure()?.errorText}`]));

    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2500));

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
    return { state, logs };
  } finally {
    await browser.close();
  }
}

// Anything from the CDN or Supabase is the sandbox having no network/credentials,
// not a defect in the page.
const isOurs = ([type, msg]) =>
  (type === "PAGEERROR" || type === "error" || type === "REQFAIL")
  && !/cdn\.jsdelivr|supabase|favicon|net::ERR_INTERNET_DISCONNECTED/i.test(msg);

const servers = [];
const temps = [];
try {
  let url = explicitUrl;
  if (!url) { servers.push(serve(ROOT, 8099)); url = "http://127.0.0.1:8099/index.html"; }

  let baseline = null;
  if (baselineRef) {
    const dir = mkdtempSync(path.join(tmpdir(), "recall-baseline-"));
    temps.push(dir);
    execFileSync("bash", ["-c", `git archive ${baselineRef} | tar -x -C ${dir}`], { cwd: ROOT });
    servers.push(serve(dir, 8098));
    baseline = "http://127.0.0.1:8098/index.html";
  }
  await new Promise((r) => setTimeout(r, 1500));

  const now = await boot(url);
  const problems = now.logs.filter(isOurs);

  console.log("── console ──");
  if (!now.logs.length) console.log("  (silent)");
  for (const [t, m] of now.logs) console.log(`  [${t}] ${m.slice(0, 400)}`);
  console.log("── state ──");
  for (const [k, v] of Object.entries(now.state)) console.log(`  ${k}: ${v}`);

  if (baseline) {
    const before = await boot(baseline);
    const diffs = Object.keys(now.state)
      .filter((k) => String(before.state[k]) !== String(now.state[k]))
      .map((k) => `  ${k}\n    ${baselineRef}: ${before.state[k]}\n    now: ${now.state[k]}`);
    console.log(`\n── vs ${baselineRef} ──`);
    console.log(diffs.length ? diffs.join("\n") : "  identical");
    if (diffs.length) problems.push(["DIFF", "state differs from the baseline"]);
  }

  console.log(`\n${problems.length} problem(s)`);
  process.exitCode = problems.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
