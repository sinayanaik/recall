// Does the app still start when the network does not cooperate?
//
//   node tools/offline-check.mjs
//
// This is the check that did not exist, and its absence is the whole reason the
// app shipped unable to launch offline for as long as it did. Everything that
// DID exist tested the app with a working connection, or offline-after-a-good-
// online-load, which is the easy half. The failures people actually hit were:
//
//   1. cdn.jsdelivr.net BLOCKED (a content blocker, a filtering proxy, a
//      country). index.html loaded eight parser-blocking <script> tags and two
//      render-blocking <link>s from that origin, so nothing painted — the app
//      shell and every boot overlay ship `hidden`, and only bootApp() unhides
//      one. A blocked CDN was a permanent blank page.
//
//   2. cdn.jsdelivr.net HANGING rather than refusing. Worse than blocked:
//      `fetch` neither resolves nor rejects, and the service worker's CDN
//      branch had no timeout, so the page waited forever with nothing on it.
//
//   3. A RELEASE, then offline. The worker precached the CDN files into a cache
//      named after the commit sha, and called skipWaiting() before refilling
//      it — so every deploy handed each install a worker whose library cache
//      was empty. release-check.mjs covers the shell across a release; it did
//      not cover this.
//
// All three are now structural: the libraries are same-origin files in vendor/,
// precached before the worker activates, in a cache the release sweep spares.
// This asserts that, by making the browser behave in each of those ways.
//
// Served under a hostname that is neither localhost nor 127.0.0.1, because the
// app deliberately unregisters its worker on those (see registerServiceWorker).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "recall.test";

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

function startServer(root) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join(ROOT, "tools/static-server.mjs"), root, "0"], { stdio: ["ignore", "pipe", "inherit"] });
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/(\d+)/);
      if (match) resolve({ child, port: Number(match[1]) });
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("static server did not report a port")), 8000);
  });
}

// What the page is showing, in the only terms that matter here: is there
// something on screen a person could read and act on, or is it blank?
const probe = () => {
  const skeleton = document.getElementById("bootSkeleton");
  const visible = (id) => {
    const node = document.getElementById(id);
    return Boolean(node && !node.hidden);
  };
  const shell = document.querySelector(".app-shell");
  return {
    skeleton: Boolean(skeleton),
    setup: visible("setupOverlay"),
    login: visible("loginOverlay"),
    libraryFailed: visible("offlineBootOverlay"),
    app: Boolean(shell && !shell.hidden),
    // The real question. innerText of <body> with everything hidden is "".
    text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120)
  };
};

// Wait for BOOT TO HAVE DECIDED, not merely for the placeholder to be gone.
//
// "!document.getElementById('bootSkeleton')" looks equivalent and is not: right
// after a reload it is briefly true of a document that has not been replaced
// yet, so it resolved in ~100ms against the OUTGOING page and every assertion
// then described the previous navigation. Waiting on a positive condition —
// one of the four screens is actually up — cannot be satisfied by the absence
// of a document.
async function waitForDecision(page, timeout = 20000) {
  await page.waitForFunction(() => {
    const visible = (id) => {
      const node = document.getElementById(id);
      return Boolean(node && !node.hidden);
    };
    const shell = document.querySelector(".app-shell");
    return visible("setupOverlay") || visible("loginOverlay")
      || visible("offlineBootOverlay") || Boolean(shell && !shell.hidden);
  }, { timeout, polling: 100 }).catch(() => {});
}

// Make the page believe what the network is actually doing.
//
// setOfflineMode() stops the requests, but in headless Chrome it does NOT flip
// navigator.onLine — it keeps reporting true. That is not a detail here: this
// app branches on navigator.onLine in updateOnlineIndicator, in the
// SIGNED_OUT-while-offline forgiveness in setupAuthListener, and in
// confirmSessionInBackground's decision about whether a missing session means
// "signed out" or "cannot tell yet". Testing with the requests blocked but the
// flag still true exercises a state no real device is ever in — and it looks
// like a failure of the app rather than of the harness (the app correctly sends
// an ONLINE device with no session to the login screen).
//
// Installed before any script on the page runs, so boot sees it from the start.
async function goOffline(page) {
  await page.setOfflineMode(true);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(Navigator.prototype, "onLine", { get: () => false, configurable: true });
  });
}

const problems = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) problems.push(`${name}${detail ? `: ${detail}` : ""}`);
}

async function main() {
  const puppeteer = loadPuppeteer();
  if (!puppeteer || !CHROME) {
    console.log("offline-check: no puppeteer/chrome available — skipping");
    return;
  }

  const { child, port } = await startServer(ROOT);
  const origin = `http://${HOST}:${port}`;
  const profile = mkdtempSync(path.join(tmpdir(), "recall-offline-"));
  let browser;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: "new",
      userDataDir: profile,
      args: [
        `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
        `--unsafely-treat-insecure-origin-as-secure=${origin}`,
        "--no-sandbox"
      ]
    });

    // ── 1. First-ever load with the CDN blocked outright ───────────────────
    // No service worker yet, no cache, nothing. This is the case that used to
    // be a permanent blank page, and the one a content blocker reproduces
    // exactly.
    {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      const blocked = [];
      page.on("request", (request) => {
        if (request.url().includes("cdn.jsdelivr.net")) {
          blocked.push(request.url());
          return request.abort();
        }
        request.continue();
      });
      await page.goto(origin, { waitUntil: "networkidle2", timeout: 30000 });
      await waitForDecision(page);
      const state = await page.evaluate(probe);
      check("cold load, CDN blocked: something is on screen", Boolean(state.text), JSON.stringify(state.text));
      check("cold load, CDN blocked: boot placeholder was cleared", !state.skeleton);
      check("cold load, CDN blocked: a real screen decided",
        state.setup || state.login || state.app,
        `setup=${state.setup} login=${state.login} app=${state.app} libraryFailed=${state.libraryFailed}`);
      check("cold load, CDN blocked: nothing on the boot path asked for the CDN",
        blocked.length === 0, blocked.slice(0, 3).join(", "));
      await page.close();
    }

    // ── 2. Warm the worker, then go fully offline ──────────────────────────
    {
      const page = await browser.newPage();
      await page.goto(origin, { waitUntil: "networkidle2", timeout: 30000 });
      await page.waitForFunction(
        "navigator.serviceWorker.controller !== null",
        { timeout: 30000 }
      ).catch(() => {});
      // Give the install's vendor precache a moment to land.
      await page.evaluate(() => new Promise((r) => setTimeout(r, 2500)));
      const cached = await page.evaluate(async () => {
        const names = await caches.keys();
        const vendor = names.includes("recall-vendor-v1")
          ? (await (await caches.open("recall-vendor-v1")).keys()).length
          : 0;
        return { names, vendor };
      });
      check("worker installed and claimed the page",
        cached.names.some((n) => n.startsWith("recall-")), cached.names.join(", "));
      check("vendored libraries precached before activation",
        cached.vendor >= 70, `${cached.vendor} entries in recall-vendor-v1`);

      await goOffline(page);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForDecision(page);
      const state = await page.evaluate(probe);
      check("offline reload: something is on screen", Boolean(state.text), JSON.stringify(state.text));
      check("offline reload: a real screen decided",
        state.setup || state.login || state.app,
        `setup=${state.setup} login=${state.login} app=${state.app}`);
      const libs = await page.evaluate(() => ({
        marked: typeof window.marked !== "undefined",
        purify: typeof window.DOMPurify !== "undefined",
        katex: typeof window.katex !== "undefined",
        supabase: typeof window.supabase !== "undefined"
      }));
      check("offline reload: every boot library loaded from cache",
        libs.marked && libs.purify && libs.katex && libs.supabase, JSON.stringify(libs));
      await page.close();
    }

    // ── 3. A CDN that HANGS, on a cold profile ─────────────────────────────
    // The nastier half of case 1: the request is accepted and simply never
    // answered. A cache-first handler with no timeout waits forever on it.
    {
      const hangProfile = mkdtempSync(path.join(tmpdir(), "recall-hang-"));
      const hangBrowser = await puppeteer.launch({
        executablePath: CHROME,
        headless: "new",
        userDataDir: hangProfile,
        args: [
          `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
          `--unsafely-treat-insecure-origin-as-secure=${origin}`,
          "--no-sandbox"
        ]
      });
      try {
        const page = await hangBrowser.newPage();
        await page.setRequestInterception(true);
        // Never call continue() or abort(): the request stays pending forever.
        page.on("request", (request) => {
          if (request.url().includes("cdn.jsdelivr.net")) return;
          request.continue();
        });
        const started = Date.now();
        await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30000 });
        await waitForDecision(page);
        const state = await page.evaluate(probe);
        const seconds = Math.round((Date.now() - started) / 100) / 10;
        check("hanging CDN: a real screen decided anyway",
          state.setup || state.login || state.app, `after ${seconds}s`);
      } finally {
        await hangBrowser.close();
        rmSync(hangProfile, { recursive: true, force: true });
      }
    }
    // ── 4. A signed-in device with a library, launched offline ────────────
    // The case the whole reordering of bootApp exists for, and the one the
    // user actually reported: decks are on this device, there is no network,
    // and the app used to answer with eight seconds of blank screen followed by
    // "Couldn't load the sign-in library" — a wall, in front of data that was
    // sitting in IndexedDB the entire time. It must open the library instead.
    {
      const page = await browser.newPage();
      await page.goto(origin, { waitUntil: "networkidle2", timeout: 30000 });
      await page.evaluate(() => {
        localStorage.setItem("flashcards_supabase_config", JSON.stringify({
          url: "https://offlinecheck.supabase.co",
          key: "sb_publishable_offline_check"
        }));
        localStorage.setItem("flashcards_last_user_id", "00000000-0000-4000-8000-000000000000");
        localStorage.setItem("flashcards_local_decks_index_v1", JSON.stringify([
          { id: "local-1", deckId: "cloud-1", title: "Offline deck", updatedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString() }
        ]));
      });

      await goOffline(page);

      const started = Date.now();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForDecision(page);
      const state = await page.evaluate(probe);
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      check("offline with a library: the app opened, not a wall",
        state.app && !state.libraryFailed && !state.login,
        `app=${state.app} libraryFailed=${state.libraryFailed} login=${state.login} after ${seconds}s`);
      check("offline with a library: it opened promptly", seconds < 8, `${seconds}s`);
      // Reached through the UI rather than by reading state, because "the app
      // opened" is only half the claim — the half that matters is that the
      // library is BROWSABLE with no connection. The welcome screen shows a
      // card, not a deck list; My Decks is where the library lives.
      // Desktop-width, so the toolbar is on screen rather than folded into the
      // ☰ drawer — this is a check about offline data, not about the mobile
      // chrome, and a click that silently lands on a hidden button would read
      // as a data failure.
      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluate(() => document.getElementById("myDecksBtn")?.click());
      const listed = await page.waitForFunction(
        () => /Offline deck/.test(document.body.innerText || ""),
        { timeout: 8000, polling: 100 }
      ).then(() => true).catch(() => false);
      check("offline with a library: the deck is browsable in My Decks", listed,
        listed ? "" : (await page.evaluate(() => (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 160))));
      const indicator = await page.evaluate(() => {
        const node = document.getElementById("offlineIndicator");
        return node ? !node.hidden : null;
      });
      check("offline with a library: the Offline pill is showing", indicator === true, String(indicator));
      await page.close();
    }
    // ── 5. The inverse: ONLINE, a library, and no session ─────────────────
    // Opening the library before the cloud has been consulted is only safe if
    // the deferred answer can still act on it — otherwise the optimistic open
    // strands people inside an app that silently syncs nothing.
    //
    // It used to act on it by showing the login screen, and this check used to
    // require that. It no longer does, because the requirement was wrong: the
    // same empty answer comes back from a stalled refresh, a captive portal and
    // a refresh token rotated out from under a resumed PWA, so what people
    // actually got was a password prompt on launch after launch while their
    // decks sat on the device, readable, needing nothing from the cloud.
    //
    // The contract now: never wall someone off from their own library, but
    // never leave the stall silent either. So the two halves are checked
    // separately — no login overlay, AND the sync pill says so and is itself
    // the way back in. See confirmSessionInBackground, and
    // tools/session-persistence-check.mjs for the failure modes in full.
    {
      const page = await browser.newPage();
      await page.goto(origin, { waitUntil: "networkidle2", timeout: 30000 });
      await page.evaluate(() => {
        localStorage.setItem("flashcards_supabase_config", JSON.stringify({
          url: "https://offlinecheck.supabase.co",
          key: "sb_publishable_offline_check"
        }));
        localStorage.setItem("flashcards_last_user_id", "00000000-0000-4000-8000-000000000000");
        localStorage.setItem("flashcards_local_decks_index_v1", JSON.stringify([
          { id: "local-1", deckId: "cloud-1", title: "Offline deck", updatedAt: new Date().toISOString(), lastSyncedAt: new Date().toISOString() }
        ]));
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
      const reachedLogin = await page.waitForFunction(() => {
        const node = document.getElementById("loginOverlay");
        return Boolean(node && !node.hidden);
      }, { timeout: 20000, polling: 100 }).then(() => true).catch(() => false);
      check("online with no session: the library is NOT walled off", !reachedLogin,
        reachedLogin ? "the login overlay took over a device that has decks on it" : "");
      // The other half: it has to SAY the sync stopped, and offer the way in.
      //
      // Checked on #signedOutIndicator, NOT on the #syncIndicator pill: that
      // pill blanks itself whenever no deck is open (see setSyncIndicator),
      // which is precisely the screen this lands on, so it reported nothing at
      // all here. That is the gap this check caught.
      const chip = await page.waitForFunction(() => {
        const node = document.getElementById("signedOutIndicator");
        if (!node || node.hidden) return null;
        return { text: (node.textContent || "").trim(), tag: node.tagName };
      }, { timeout: 20000, polling: 100 }).then((h) => h.jsonValue()).catch(() => null);
      check("online with no session: a sign-in is offered on screen", Boolean(chip),
        chip ? `"${chip.text}" <${chip.tag.toLowerCase()}>` : await page.evaluate(() => {
          const node = document.getElementById("signedOutIndicator");
          return node ? `chip hidden=${node.hidden}` : "no chip in the document";
        }));
      // And it has to be the way back in, not just a label.
      const opensLogin = await page.evaluate(() => {
        document.getElementById("signedOutIndicator")?.click();
        const login = document.getElementById("loginOverlay");
        return Boolean(login && !login.hidden);
      });
      check("online with no session: the sign-in offer opens the login screen", opensLogin,
        opensLogin ? "" : "clicking it did not show #loginOverlay");
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\n${problems.length} problem(s)`);
  if (problems.length) process.exit(1);
}

main().catch((error) => {
  console.error("offline-check failed:", error);
  process.exit(1);
});
