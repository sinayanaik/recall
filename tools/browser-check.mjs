// Does tools/browser.mjs actually drive a browser?
//
//   node tools/browser-check.mjs
//
// Sixteen checks now reach Chrome through that shim rather than through
// puppeteer, which makes it the single point of failure under every end-to-end
// answer this repo has. It is also the one piece of the suite whose failure
// mode is the one this whole area was just rebuilt to remove: a method that
// quietly resolves to undefined reads, at the call site, exactly like a page
// that had nothing to say. `page.setViewport` shipped in its first draft
// throwing "Touch points must be between 1 and 16" on every desktop check,
// found here rather than by twelve checks failing for a reason none of them
// could name.
//
// So each wrapped method is exercised against the real app, and each assertion
// is written so that a stub returning undefined FAILS rather than passes.
//
// Deliberately not a parity test against puppeteer: puppeteer is not installed
// anywhere this runs, and if it were the shim would not be needed.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, findChrome } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serve(root) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [path.join(ROOT, "tools/static-server.mjs"), root], {
      stdio: ["ignore", "pipe", "inherit"]
    });
    const deadline = setTimeout(() => reject(new Error("static server did not report a port")), 15000);
    proc.stdout.once("data", (d) => {
      clearTimeout(deadline);
      resolve({ proc, base: `http://127.0.0.1:${String(d).trim()}` });
    });
  });
}

const results = [];
const check = (name, ok, detail = "") => results.push([Boolean(ok), name, detail]);

const chrome = findChrome();
if (!chrome) {
  // Not a skip. If there is no browser then sixteen checks cannot run either,
  // and saying so once here is more use than saying it sixteen times.
  console.log("browser-check: no Chrome found. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

const server = await serve(ROOT);
let browser;
try {
  browser = await launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const logs = [];
  page.on("console", (m) => logs.push([m.type(), m.text()]));

  // ── Interception, which is how every check keeps the CDN out ─────────────
  const blocked = [];
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? (blocked.push(r.url()), r.abort()) : r.continue()));

  await page.evaluateOnNewDocument("window.__injectedEarly = 'yes';");
  await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 60000 });

  check("goto lands on the app", (await page.evaluate(() => document.title)) === "Recall",
    await page.evaluate(() => document.title));
  // The one that matters most: main.js reads `marked` during module evaluation,
  // so a script added after navigation is far too late and every check that
  // stubs a library depends on this running first.
  check("evaluateOnNewDocument runs before the page's own scripts",
    (await page.evaluate(() => window.__injectedEarly)) === "yes");
  check("evaluate passes arguments through", (await page.evaluate((a, b) => a + b, 2, 40)) === 42);
  check("evaluate awaits a promise in the page",
    (await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 10)); return "late"; })) === "late");
  check("evaluate accepts a bare expression string", (await page.evaluate("1 + 1")) === 2);
  check("evaluate turns a page throw into a rejection", await (async () => {
    try { await page.evaluate(() => { throw new Error("boom"); }); return false; }
    catch (error) { return /boom/.test(error.message); }
  })());

  await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 });
  check("waitForFunction resolves once the app has booted", true);
  const handle = await page.waitForFunction(() => ({ ok: 1 }), { timeout: 2000 });
  check("waitForFunction hands back a value, not just a signal", (await handle.jsonValue()).ok === 1);
  check("waitForFunction rejects rather than hanging", await (async () => {
    try { await page.waitForFunction(() => false, { timeout: 300 }); return false; } catch (_) { return true; }
  })());

  check("waitForSelector finds a node that is there", Boolean(await page.waitForSelector("#setupOverlay", { timeout: 5000 })));
  check("setViewport reaches the page", (await page.evaluate(() => window.innerWidth)) === 1280,
    String(await page.evaluate(() => window.innerWidth)));

  // ── Input ───────────────────────────────────────────────────────────────
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "browserCheckProbe";
    probe.style.cssText = "position:fixed;left:40px;top:40px;width:120px;height:60px;z-index:99999";
    probe.dataset.seen = "";
    probe.addEventListener("mousedown", () => { probe.dataset.seen += "down "; });
    probe.addEventListener("mouseup", () => { probe.dataset.seen += "up "; });
    probe.addEventListener("click", () => { probe.dataset.seen += "click "; });
    document.body.appendChild(probe);
  });
  await page.mouse.move(100, 70);
  await page.mouse.down();
  await page.mouse.up();
  const seenByMouse = await page.evaluate(() => document.getElementById("browserCheckProbe").dataset.seen.trim());
  check("mouse down/up reach a real element as trusted events", seenByMouse === "down up click", seenByMouse);

  await page.evaluate(() => { document.getElementById("browserCheckProbe").dataset.seen = ""; });
  await page.click("#browserCheckProbe");
  const seenByClick = await page.evaluate(() => document.getElementById("browserCheckProbe").dataset.seen.trim());
  check("click() presses the element it names", seenByClick === "down up click", seenByClick);

  // ── The rest of the surface ─────────────────────────────────────────────
  const shot = await page.screenshot();
  check("screenshot returns PNG bytes", shot.length > 1000 && shot[1] === 0x50, `${shot.length} bytes`);

  await page.addScriptTag({ content: "window.__tagAdded = 7;" });
  check("addScriptTag defines a global, as a classic script would",
    (await page.evaluate(() => window.__tagAdded)) === 7);

  const session = await page.target().createCDPSession();
  const ua = await session.send("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true });
  check("target().createCDPSession speaks the raw protocol", /Chrome/.test(ua.result?.value || ""));

  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  check("reload re-runs the page", (await page.evaluate(() => window.__tagAdded)) === undefined
    && (await page.evaluate(() => window.__injectedEarly)) === "yes");

  await page.setOfflineMode(true);
  const offline = await page.evaluate(async () => {
    try { await fetch("/manifest.webmanifest", { cache: "no-store" }); return "resolved"; } catch (_) { return "rejected"; }
  });
  await page.setOfflineMode(false);
  check("setOfflineMode actually stops the network", offline === "rejected", offline);

  const online = await page.evaluate(async () => {
    try { const r = await fetch("/manifest.webmanifest", { cache: "no-store" }); return r.ok ? "ok" : `status ${r.status}`; }
    catch (error) { return `threw: ${error.message}`; }
  });
  check("...and lets it back afterwards", online === "ok", online);

  // Interception, proven by a URL that must never reach the network. The app
  // asks for cdn.jsdelivr.net only on demand, so this drives one deliberately.
  const aborted = await page.evaluate(async () => {
    try { await fetch("https://cdn.jsdelivr.net/npm/nothing-here", { mode: "no-cors" }); return "resolved"; }
    catch (_) { return "rejected"; }
  });
  check("setRequestInterception + abort() blocks a request", aborted === "rejected" && blocked.length > 0,
    `${aborted}, ${blocked.length} blocked`);

  check("the app booted without a page error", errors.length === 0, errors.slice(0, 2).join(" | "));
  check("the console listener is wired", Array.isArray(logs));

  // ── The one that took a 57KB argument to find ───────────────────────────
  //
  // tools/highlight-check.mjs passes its whole probe SOURCE as an argument.
  // While arguments were spliced into the expression as JSON literals, that
  // source had to survive being re-parsed inside a larger program, and did not:
  // "SyntaxError: Invalid or unexpected token", raised inside the page, naming
  // neither the argument nor the call. Arguments go through callFunctionOn now
  // and are never parsed. A big, awkward string is the case that tells the two
  // implementations apart.
  const awkward = [
    "`backticks` and ${templates}",
    "a 'single' and a \"double\" quote",
    "a backslash \\ and a newline \n and a tab \t",
    "</script> and <!-- -->",
    "unicode: \u2028 \u2029 \u0000 \ud83d\ude80 中文",
    "x".repeat(60000)
  ].join("\n");
  check("evaluate carries a large, hostile string argument intact",
    (await page.evaluate((text) => text.length, awkward)) === awkward.length,
    `${awkward.length} chars`);
  check("...byte for byte, and back again",
    (await page.evaluate((text) => text, awkward)) === awkward);
  check("...including when the argument is itself source that gets eval'd",
    (await page.evaluate((src) => (0, eval)("(" + src + ")")(2), "(n) => n * 21")) === 42);

  await page.close();
  check("a closed page leaves the browser with none", browser.pages().length === 0,
    `${browser.pages().length} left`);
} catch (error) {
  check(`the check itself: ${error?.message || error}`, false);
} finally {
  try { await browser?.close(); } catch (_) { /* closing anyway */ }
  server.proc.kill();
}

let failed = 0;
for (const [ok, name, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? " ok " : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}
console.log(`\nCHECK: ${results.length} checks · ${failed} failed`);
process.exit(failed ? 1 : 0);
