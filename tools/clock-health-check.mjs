// Does App Info tell the reader WHOSE clock is wrong?
//
//   node tools/clock-health-check.mjs
//
// The bug this exists for: reconcileAllDecks raises "Another device's clock is
// wrong" whenever a cloud deck is stamped past this device's own clock. That
// comparison cannot attribute the fault — a laptop running slow looks exactly
// like another device running fast — so the app was naming a culprit it had no
// evidence for, and sending the reader to check devices that were fine.
//
// Worse, the stamp is a ratchet: nextSyncStamp writes max(now, previous + 1ms)
// on every push and every local edit, so one episode of skew is carried forward
// by every device forever and the warning never clears. That part is NOT fixed
// here, deliberately — it is sync-ordering arithmetic and wants its own change.
// What is fixed is the diagnosis, so the numbers behind that decision can be
// read off a panel instead of guessed at.
//
// So this drives the real page, hands it a server clock of our choosing through
// the one header the answer comes from, seeds a deck stamped in the future, and
// asserts on the words the reader actually gets.
//
// Needs a Chrome, found by tools/browser.mjs, exactly like boot-check.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = findChrome();

if (!CHROME) {
  // Not a skip: a check that cannot run has not passed. tools/check.mjs counts
  // this as a failure and names it.
  console.error("clock-health-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
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
      if (nl !== -1) resolve({ proc, base: `http://127.0.0.1:${buf.slice(0, nl).trim()}` });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("static server did not start")), 10000);
  });
}

const HOUR_MS = 60 * 60 * 1000;

// `serverSkewMs` is what the stubbed Date header reports RELATIVE TO the
// browser's real clock: negative means the server is behind us, i.e. this
// device is running fast. `deckAheadMs` stamps the seeded deck that far past
// real now.
const CASES = [
  {
    name: "clocks agree, no future stamps",
    real: "the ordinary machine — this row must not cry wolf",
    serverSkewMs: 0, deckAheadMs: 0,
    expect: { clock: "ok", stamps: "ok" }
  },
  {
    name: "this device is an hour behind the server",
    real: "the laptop that woke from sleep with a stale clock",
    serverSkewMs: HOUR_MS, deckAheadMs: 0,
    expect: { clock: "fail", stamps: "ok", clockText: /behind/i, summaryNotSql: true }
  },
  {
    name: "this device is an hour ahead of the server",
    real: "the device that is itself stamping everyone else's future",
    // The stamps row is "warn" here and that is the POINT, not a side effect:
    // a deck this fast device stamped at its own "now" genuinely does sit an
    // hour past real time, so the panel attributes the future stamps to the
    // machine the reader is sitting at rather than to an absent one.
    serverSkewMs: -HOUR_MS, deckAheadMs: 0,
    expect: { clock: "fail", stamps: "warn", clockText: /ahead of/i, summaryNotSql: true }
  },
  {
    // The reported condition: clocks are fine NOW, and a deck still carries a
    // stamp from the future because the ratchet never let it back down. The
    // warning fires and no amount of checking device clocks clears it, so the
    // panel has to show the stamp itself.
    name: "clock fine, a deck stamped two hours ahead",
    real: "the ratchet — one past episode of skew, carried forward forever",
    serverSkewMs: 0, deckAheadMs: 2 * HOUR_MS,
    expect: { clock: "ok", stamps: "warn", stampsText: /2 hours/, summaryNotSql: true }
  }
];

function stubScript(kase) {
  return `(() => {
    try {
      localStorage.setItem("flashcards_supabase_config",
        JSON.stringify({ url: "https://demoproject.supabase.co", key: "anon-key-that-is-long-enough-to-pass" }));
      localStorage.setItem("flashcards_last_user_id", "user-1111-2222");
      localStorage.setItem("flashcards_local_decks_index_v1", JSON.stringify([
        {
          id: "deck-1",
          title: "Thermodynamics",
          updatedAt: new Date(Date.now() + ${kase.deckAheadMs}).toISOString(),
          cardCount: 1
        }
      ]));
    } catch (e) {}
  })();`;
}

async function run(base, kase) {
  const browser = await launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => {
      if (r.url().includes("cdn.jsdelivr.net")) return r.abort();
      // ── The server's clock, set by us ───────────────────────────────────
      //
      // fetchServerTime asks for this page's own index.html with HEAD and reads
      // the Date header off the reply — so answering just the HEAD, and leaving
      // every GET alone, hands the app a server clock without disturbing the
      // load. Method-scoped precisely because the document itself is the same
      // URL.
      if (r.method() === "HEAD") {
        return r.respond({
          status: 200,
          contentType: "text/html",
          headers: { date: new Date(Date.now() + kase.serverSkewMs).toUTCString() },
          body: ""
        });
      }
      return r.continue();
    });
    await page.evaluateOnNewDocument(stubScript(kase));

    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
    try {
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("app-booting"),
        { timeout: 30000 }
      );
    } catch (_) { /* reported through the rows below */ }

    // The panel is asked directly rather than clicked open: what is under test
    // is the report, and driving the menu would test the menu. renderProjectHealth
    // is called too, because the words the READER gets are the point — a row
    // object nobody paints is not a diagnosis.
    const rows = await page.evaluate(async () => {
      const mod = await import("/src/pwa/app-info.js?v=__BUILD__");
      const results = await mod.checkProjectHealth();
      mod.renderProjectHealth(results);
      const summaryEl = document.getElementById("appInfoHealthSummary");
      return {
        results: results.map((r) => ({ label: r.label, status: r.status, detail: r.detail })),
        rendered: [...document.querySelectorAll(".app-info-health-item")].map((li) => li.textContent),
        summary: summaryEl && !summaryEl.hidden ? summaryEl.textContent : ""
      };
    });
    return { ...rows, errors };
  } finally {
    await browser.close();
  }
}

const { proc, base } = await serveOn(ROOT);
let checks = 0;
let problems = 0;

function assert(ok, what, got) {
  checks++;
  if (!ok) {
    problems++;
    console.log(`        FAIL  ${what}`);
    console.log(`              got: ${got}`);
  }
}

try {
  for (const kase of CASES) {
    const got = await run(base, kase);
    console.log(`      ${kase.name}`);
    console.log(`        ${kase.real}`);
    const clock = got.results.find((r) => r.label === "Device clock");
    const stamps = got.results.find((r) => r.label === "Deck timestamps");

    // Both rows must EXIST regardless of sign-in: they are placed ahead of
    // checkProjectHealth's early returns precisely so the report that explains
    // a signed-out device still carries them. This harness never signs in, so
    // a row that drifted behind those returns fails here.
    assert(Boolean(clock), "the Device clock row is present", JSON.stringify(got.results.map((r) => r.label)));
    assert(Boolean(stamps), "the Deck timestamps row is present", JSON.stringify(got.results.map((r) => r.label)));
    if (!clock || !stamps) continue;

    assert(clock.status === kase.expect.clock,
      `Device clock is "${kase.expect.clock}"`, `"${clock.status}" — ${clock.detail}`);
    assert(stamps.status === kase.expect.stamps,
      `Deck timestamps is "${kase.expect.stamps}"`, `"${stamps.status}" — ${stamps.detail}`);
    if (kase.expect.clockText) {
      assert(kase.expect.clockText.test(clock.detail),
        `the clock row says which way it is wrong (${kase.expect.clockText})`, clock.detail);
    }
    if (kase.expect.stampsText) {
      assert(kase.expect.stampsText.test(stamps.detail),
        `the stamps row names how far ahead (${kase.expect.stampsText})`, stamps.detail);
      assert(/Thermodynamics/.test(stamps.detail),
        "the stamps row names the deck", stamps.detail);
    }
    // The standing advice on this panel is "re-run supabase_setup.sql". For a
    // clock or a timestamp it is useless and wrong — nothing about the project
    // is broken — and it was the whole summary before this change.
    if (kase.expect.summaryNotSql) {
      assert(!/supabase_setup\.sql/.test(got.summary),
        "the summary does not blame the project's SQL", got.summary || "(no summary shown)");
      assert(got.summary.length > 0, "a summary is shown at all", "(none)");
    }
    // Whatever the rows say, they have to reach the list the reader looks at.
    assert(got.rendered.some((t) => t.includes("Device clock")),
      "the Device clock row is rendered", JSON.stringify(got.rendered));

    if (got.errors.length) {
      problems++;
      checks++;
      console.log(`        PAGE ERRORS: ${got.errors.join(" | ")}`);
    }
  }
} finally {
  proc.kill();
}

console.log(`\n${problems} problem(s)`);
console.log(`CHECK: ${checks} checks · ${problems} failed`);
process.exit(problems ? 1 : 0);
