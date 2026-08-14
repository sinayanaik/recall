// Does a release actually reach an existing install, and does it work offline?
//
//   node tools/release-check.mjs
//
// This is the failure this repo has already shipped twice: versioned assets are
// cached first and never revalidated, so a release that does not change the
// worker's CACHE_NAME leaves every existing install being served the previous
// bundle, indefinitely. It is invisible on localhost, where the app deliberately
// unregisters its worker so edits are not masked — which is exactly why it was
// only ever discovered by other people.
//
// The split makes the question sharper, not softer: there are now 130 module
// URLs instead of one, and a worker that serves a NEW index.html against an OLD
// module is a mixed build that runs old code inside new markup.
//
// So this drives the real thing:
//
//   1. stamp the tree as release A, exactly as .github/workflows/deploy.yml does
//   2. load it, wait for the service worker to install and take control
//   3. go offline, reload — the app must still boot from cache
//   4. swap the served tree to release B and reload
//   5. the new worker must install, and the page must end up on B, not A
//
// The app skips worker registration on localhost and 127.0.0.1, so this serves
// under a hostname that is neither and tells Chrome to treat it as secure.

import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "recall.test";
const PORT = 8092;
const ORIGIN = `http://${HOST}:${PORT}`;

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
if (!puppeteer || !CHROME) { console.log("release-check: no puppeteer/Chrome — skipping."); process.exit(0); }

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

// Exactly what deploy.yml does: substitute the placeholders everywhere.
function stamp(dir, sha) {
  // src/** on this branch, a single app.js before it — so the same check can be
  // pointed at the pre-split build to tell a regression from a pre-existing trait.
  const appFiles = existsSync(path.join(dir, "src"))
    ? walk(path.join(dir, "src"))
    : [path.join(dir, "app.js")];
  const files = [path.join(dir, "index.html"), path.join(dir, "sw.js"), ...appFiles];
  for (const f of files) {
    const before = readFileSync(f, "utf8");
    const after = before
      .replaceAll("__BUILD__", sha)
      .replaceAll("__BUILD_TIME__", "2026-08-14T00:00:00+00:00");
    if (after !== before) writeFileSync(f, after);
  }
}

const tmp = mkdtempSync(path.join(tmpdir(), "recall-release-"));
const dirA = path.join(tmp, "a");
const dirB = path.join(tmp, "b");
execFileSync("bash", ["-c", `mkdir -p ${dirA} ${dirB}`]);
const SRC_REF = (process.argv.find((a) => a.startsWith("--from=")) || "").slice(7);
for (const d of [dirA, dirB]) {
  if (SRC_REF) execFileSync("bash", ["-c", `cd ${ROOT} && git archive ${SRC_REF} | tar -x -C ${d}`]);
  else execFileSync("bash", ["-c",
    `cd ${ROOT} && tar -c index.html sw.js manifest.webmanifest src styles icons | tar -x -C ${d}`]);
}
stamp(dirA, "aaaaaa1");
stamp(dirB, "bbbbbb2");

// One server whose document root can be swapped between releases mid-test.
const serverJs = path.join(tmp, "server.mjs");
writeFileSync(serverJs, `
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
let root = process.argv[2];
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css",
                ".json":"application/json", ".png":"image/png", ".webmanifest":"application/manifest+json" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__switch") { root = url.searchParams.get("to"); res.writeHead(200); res.end("ok"); return; }
  const file = path.join(root, url.pathname === "/" ? "/index.html" : url.pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("no"); }
}).listen(${PORT}, "127.0.0.1");
`);
const server = spawn(process.execPath, [serverJs, dirA], { stdio: "ignore" });

const say = (ok, msg) => { console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`); return ok; };
let failures = 0;
const check = (ok, msg) => { if (!say(ok, msg)) failures++; };

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: CHROME,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage",
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`
  ]
});

try {
  await new Promise((r) => setTimeout(r, 1200));
  const page = await browser.newPage();

  // ── 1. Install release A ────────────────────────────────────────────────
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
  const controlled = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 100 && !navigator.serviceWorker.controller; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!navigator.serviceWorker.controller) location.reload();
      break;
    }
    return Boolean(reg);
  });
  check(controlled, "release A: service worker registers");

  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await new Promise((r) => setTimeout(r, 3000));   // let the precache finish

  const cachedA = await page.evaluate(async () => {
    const names = await caches.keys();
    const shell = names.find((n) => n.startsWith("recall-") && !n.includes("images"));
    if (!shell) return { name: null, modules: 0, styles: 0 };
    const keys = await (await caches.open(shell)).keys();
    const urls = keys.map((k) => k.url);
    return {
      name: shell,
      modules: urls.filter((u) => u.includes("/src/")).length,
      styles: urls.filter((u) => u.includes("/styles/")).length,
      total: urls.length
    };
  });
  check(cachedA.name === "recall-aaaaaa1", `release A: cache is ${cachedA.name} (want recall-aaaaaa1)`);
  if (!SRC_REF) {
    check(cachedA.modules >= 130, `release A: ${cachedA.modules} modules precached (want >= 130)`);
    check(cachedA.styles === 13, `release A: ${cachedA.styles} stylesheets precached (want 13)`);
  }

  // ── 2. Offline ──────────────────────────────────────────────────────────
  const cdp = await page.target().createCDPSession();
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const offlineErrors = [];
  page.on("pageerror", (e) => offlineErrors.push(e.message));
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  const offline = await page.evaluate(() => ({
    booted: !document.documentElement.classList.contains("app-booting"),
    setup: !document.getElementById("setupScreen")?.hasAttribute("hidden"),
    styled: getComputedStyle(document.body).backgroundColor,
    version: window.__recallBoot ? "n/a" : "n/a"
  }));
  check(offline.booted, "offline: the module graph evaluated to its last line");
  check(offline.setup, "offline: the app rendered");
  check(offline.styled !== "rgba(0, 0, 0, 0)" && offline.styled !== "", `offline: styles applied (body background ${offline.styled})`);
  check(offlineErrors.length === 0, `offline: no page errors${offlineErrors.length ? " — " + offlineErrors[0] : ""}`);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // ── 3. Publish release B ────────────────────────────────────────────────
  //
  // An update does NOT take over on its own, by design: the old worker refuses
  // to serve the new HTML (that is what stops a mixed build), so the new worker
  // installs and WAITS, and the app shows a banner. Pressing Reload posts
  // skip-waiting and reloads. A test that just reloads twice is testing the
  // refusal, not the update — and would "pass" against an app that could never
  // update at all.
  await fetch(`http://127.0.0.1:${PORT}/__switch?to=${encodeURIComponent(dirB)}`);
  await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
  });

  const banner = await page.waitForSelector(".update-banner", { timeout: 30000 }).catch(() => null);
  check(Boolean(banner), "update: the new release is announced to the running page");

  const held = await page.evaluate(() =>
    document.querySelector('script[type="module"]')?.getAttribute("src")?.match(/v=([^&"']+)/)?.[1]);
  check(held === "aaaaaa1", `update: the old worker still serves its OWN release until told (?v=${held})`);

  if (banner) {
    // Press like a person would, a beat after the banner appears — not in the
    // same millisecond. Clicking the instant it renders can beat the
    // registration's `waiting` reference into existence, which is a race no
    // real user runs.
    await new Promise((r) => setTimeout(r, 1500));
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
      page.evaluate(() => document.querySelector(".update-banner button")?.click())
    ]);
    await new Promise((r) => setTimeout(r, 3000));
  }

  // What the page is on immediately after pressing Reload, and after one more
  // navigation. The app guards against reload LOOPS (it will not auto-reload
  // twice inside a minute), so the interesting question is whether the release
  // lands on the press or one navigation later — either is fine, silently never
  // is not.
  const readStamp = () => page.evaluate(() => {
    const tag = document.querySelector('script[type="module"]') || document.querySelector('script[src*="app.js"]');
    return tag?.getAttribute("src")?.match(/v=([^&"']+)/)?.[1];
  });
  const straightAfterPress = await readStamp();
  // How many further navigations it takes to converge. One is expected: the
  // reload races skipWaiting and the app declines to auto-reload twice inside a
  // minute. Never converging would be a different thing entirely.
  let navs = 0;
  for (; navs < 4; navs++) {
    if (await readStamp() === "bbbbbb2") break;
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: "networkidle2", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 2000));
  }

  const after = await page.evaluate(async () => {
    const names = await caches.keys();
    const tag = document.querySelector('script[type="module"]') || document.querySelector('script[src*="app.js"]');
    const src = tag?.getAttribute("src") || "";
    const stamp = src.match(/v=([^&"']+)/)?.[1];
    let running = null;
    try { running = (await import("./src/core/build.js?v=" + stamp)).BUILD_STAMP; }
    catch { running = (await (await fetch(src)).text()).match(/BUILD_STAMP = "([^"]+)"/)?.[1] || null; }
    return { caches: names.filter((n) => !n.includes("images")), running, requested: stamp };
  });
  console.log(`        (straight after the press: ?v=${straightAfterPress}; converged after ${navs} further navigation(s))`);
  // Pressing Reload must LAND the release, not merely start it moving. Before
  // the banner waited for controllerchange this needed 1-2 further navigations
  // every single run, and the app's own reload-loop guard meant those had to
  // come from the user.
  check(straightAfterPress === "bbbbbb2", `update: pressing Reload lands release B (got ?v=${straightAfterPress})`);
  check(after.requested === "bbbbbb2", `update: page ends up on release B (?v=${after.requested})`);
  check(after.running === "bbbbbb2", `update: RUNNING code is release B (BUILD_STAMP ${after.running})`);
  check(after.running === after.requested, "update: requested and running agree — not a mixed build");
  check(after.caches.includes("recall-bbbbbb2"), `update: cache recall-bbbbbb2 exists (${after.caches.join(", ")})`);
  check(!after.caches.includes("recall-aaaaaa1"), "update: release A's cache was swept");

  console.log(failures ? `\n${failures} release check(s) failed.` : "\nRelease path verified: install, offline, and update.");
} finally {
  await browser.close();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);
