// Does a launch keep the user signed in?
//
//   node tools/session-persistence-check.mjs
//
// The bug this exists for: the app asked for the password on almost every
// launch. Not because the session was gone — because every way of FAILING to
// confirm one (a slow refresh, a captive portal, a refresh token rotated out
// from under a resumed PWA) returned the same `null` as a deliberate sign-out,
// and boot read that one null as "signed out" and showed the wall.
//
// So this drives the real page with a stubbed supabase-js whose getSession()
// fails in each of those ways in turn, and asserts on the only thing the user
// cares about: is the login overlay in my face, or are my decks?
//
// Needs a Chrome, found by tools/browser.mjs, exactly like boot-check.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Chrome comes from tools/browser.mjs, which drives it over the DevTools
// protocol rather than through puppeteer. This used to be a hard-coded list of
// five /usr/bin paths plus a puppeteer under one person's nvm directory, and on
// any machine that matched neither — every container, every CI runner — the
// guard below printed "skipping." and exited 0, which the suite scored as a
// pass. See tools/browser.mjs for the whole story.
const CHROME = findChrome();

if (!CHROME) {
  // Not a skip: a check that cannot run has not passed. tools/check.mjs counts
  // this as a failure and names it.
  console.error("session-persistence-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
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

const VENDORED = [
  path.join(ROOT, "recall-clipper/vendor/marked.min.js"),
  path.join(ROOT, "recall-clipper/vendor/purify.min.js")
];

const PROJECT_URL = "https://demoproject.supabase.co";
const SESSION_STORAGE_KEY = "sb-demoproject-auth-token";
// Recall's own copy of the refresh token, kept because supabase-js DELETES the
// record above whenever it decides a refresh has failed for good.
const SESSION_BACKUP_KEY = "recall:session-backup-v1";

// The scenarios, and what each one is standing in for.
//
// `session` is what the stubbed getSession() resolves (or "hang" / "throw"),
// `stored` is whether supabase-js's own session record is still in
// localStorage, and `library` is whether this device has decks on it.
const CASES = [
  {
    name: "live session",
    real: "the ordinary launch",
    session: "live", stored: true, library: true, expectLogin: false
  },
  {
    name: "refresh hangs (captive portal / dead cell)",
    real: "connected to something that accepts the request and never answers",
    session: "hang", stored: true, library: true, expectLogin: false
  },
  {
    name: "refresh throws",
    real: "the project is asleep, or the refresh token was already used",
    session: "throw", stored: true, library: true, expectLogin: false
  },
  {
    name: "session evicted, decks on device",
    real: "supabase-js gave up on the token and cleared it, mid-session",
    session: "none", stored: false, library: true, expectLogin: false
  },
  {
    name: "refresh hangs, no decks yet",
    real: "a fresh install that has synced nothing, on a bad connection",
    session: "hang", stored: true, library: false, expectLogin: false
  },
  {
    // The case supabase-js's own eviction creates, and the one nothing could
    // recover from: its session record is gone, so `hasRememberedSession` said
    // no, so boot showed the wall — on a device that has a perfectly good
    // refresh token sitting beside it. Two assertions, not one: the wall must
    // stay away AND the sign-in must actually come back, or this is only a
    // nicer way of being signed out.
    name: "session evicted, a remembered refresh token",
    real: "supabase-js gave up on the token; the copy kept beside it can still be spent",
    session: "none", stored: false, library: false, backup: true,
    expectLogin: false, expectRecovered: true
  },
  {
    name: "never signed in here",
    real: "a genuinely new device — the wall is CORRECT here",
    session: "none", stored: false, library: false, expectLogin: true
  }
];

// A GoTrue token response, shaped as supabase-js will read it.
//
// The access token has to be a real JWT — three base64url segments — because the
// client DECODES it to learn when it expires. Nothing verifies the signature on
// this side, so the third segment is a placeholder; everything the client acts
// on is in the payload.
// The project is a different origin from the page, so every one of these needs
// the header that lets the browser hand the reply to the app at all — and the
// custom headers supabase-js sends (apikey, x-client-info) make Chrome ask
// first, with an OPTIONS nobody would otherwise answer.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*"
};

function tokenResponse(method) {
  if (String(method).toUpperCase() === "OPTIONS") {
    return { status: 204, contentType: "text/plain", body: "", headers: CORS };
  }
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const access = `${b64({ alg: "HS256", typ: "JWT" })}.`
    + `${b64({ sub: "user-1111-2222", aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 })}`
    + ".signature-not-checked-here";
  return {
    status: 200,
    contentType: "application/json",
    headers: CORS,
    body: JSON.stringify({
      access_token: access,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      // Rotated, exactly as a real project rotates it — which is also what the
      // app is expected to write back over its own remembered copy.
      refresh_token: "rt-rotated",
      user: {
        id: "user-1111-2222", aud: "authenticated", role: "authenticated",
        email: "reader@example.com", app_metadata: {}, user_metadata: {},
        created_at: new Date(0).toISOString()
      }
    })
  };
}

function stubScript(kase) {
  return `(() => {
    const CASE = ${JSON.stringify(kase)};
    const user = { id: "user-1111-2222", email: "reader@example.com" };
    const live = {
      user, access_token: "at", refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) + 3600
    };
    const never = new Promise(() => {});
    const getSession = () => {
      if (CASE.session === "live") return Promise.resolve({ data: { session: live }, error: null });
      if (CASE.session === "hang") return never;
      if (CASE.session === "throw") return Promise.reject(new Error("Invalid Refresh Token: Already Used"));
      return Promise.resolve({ data: { session: null }, error: null });
    };
    window.supabase = {
      createClient: () => ({
        auth: {
          getSession,
          refreshSession: getSession,
          signOut: () => Promise.resolve({ error: null }),
          signInWithPassword: () => Promise.resolve({ data: { user, session: live }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
        },
        from: () => {
          const q = new Proxy(function () {}, {
            get: (_t, prop) => (prop === "then"
              ? (res) => Promise.resolve({ data: [], error: null }).then(res)
              : () => q),
            apply: () => q
          });
          return q;
        },
        storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) }
      })
    };
    localStorage.setItem("flashcards_supabase_config",
      JSON.stringify({ url: ${JSON.stringify(PROJECT_URL)}, key: "anon-key-that-is-long-enough-to-pass" }));
    if (CASE.stored) {
      localStorage.setItem(${JSON.stringify(SESSION_STORAGE_KEY)}, JSON.stringify({
        access_token: "at", refresh_token: "rt", user,
        expires_at: Math.floor(Date.now() / 1000) - 60
      }));
    }
    if (CASE.backup) {
      localStorage.setItem(${JSON.stringify(SESSION_BACKUP_KEY)}, JSON.stringify({
        ref: "demoproject", userId: user.id, refreshToken: "rt", at: Date.now()
      }));
    }
    if (CASE.library) {
      localStorage.setItem("flashcards_last_user_id", user.id);
      localStorage.setItem("flashcards_local_decks_index_v1", JSON.stringify([
        { id: "deck-1", name: "Offline deck", updatedAt: new Date(0).toISOString(), cardCount: 1 }
      ]));
    }
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
      // ── The project's token endpoint, answered ─────────────────────────
      //
      // supabase-js is VENDORED in this repo, so the script tag in index.html
      // overwrites the stub above with the real library — which is the right
      // thing for every case here and the reason they are worth running at all:
      // what is under test is the app's behaviour against the real client. But
      // the real client goes to the network for a refresh, and this project does
      // not exist. Every other case wants that failure. This one wants the
      // opposite, so the one request restoreSessionFromBackup makes is given the
      // answer a live project would give it.
      if (kase.backup && /\/auth\/v1\/token/.test(r.url())) return r.respond(tokenResponse(r.method()));
      return r.continue();
    });
    for (const lib of VENDORED) {
      if (existsSync(lib)) await page.evaluateOnNewDocument(readFileSync(lib, "utf8"));
    }
    // Before the app's own scripts: it builds its client during boot.
    await page.evaluateOnNewDocument(stubScript(kase));

    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto(base, { waitUntil: "domcontentloaded", timeout: 60000 });
    try {
      await page.waitForFunction(
        () => !document.documentElement.classList.contains("app-booting"),
        { timeout: 30000 }
      );
    } catch (_) { /* reported via the state below */ }
    // Past SESSION_RESTORE_TIMEOUT_MS (8s), so the "hang" cases have actually
    // timed out and boot has done whatever it is going to do about it.
    await new Promise((r) => setTimeout(r, 10000));

    return {
      ...(await page.evaluate(() => {
        const visible = (id) => {
          const node = document.getElementById(id);
          return Boolean(node) && !node.hidden && getComputedStyle(node).display !== "none";
        };
        return {
          loginVisible: visible("loginOverlay"),
          setupVisible: visible("setupOverlay"),
          // The chip is the standing "syncing is paused" mark. Down means the
          // session came back, which is the half of a recovery that a login
          // wall staying away does not by itself prove.
          chipVisible: visible("signedOutIndicator"),
          syncPill: document.getElementById("syncIndicator")?.textContent?.trim() || "",
          pillAction: document.getElementById("syncIndicator")?.dataset.action || ""
        };
      })),
      errors
    };
  } finally {
    await browser.close();
  }
}

const { proc, base } = await serveOn(ROOT);
let problems = 0;
try {
  for (const kase of CASES) {
    const got = await run(base, kase);
    const recovered = !got.chipVisible;
    const ok = got.loginVisible === kase.expectLogin
      && (!kase.expectRecovered || recovered);
    if (!ok) problems++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${kase.name}`);
    console.log(`        ${kase.real}`);
    console.log(`        login wall: ${got.loginVisible} (expected ${kase.expectLogin})` +
      `${kase.expectRecovered ? `, signed back in: ${recovered} (expected true)` : ""}` +
      `${got.syncPill ? `, pill: "${got.syncPill}"${got.pillAction ? ` [${got.pillAction}]` : ""}` : ""}`);
    if (got.errors.length) {
      problems++;
      console.log(`        PAGE ERRORS: ${got.errors.join(" | ")}`);
    }
  }
} finally {
  proc.kill();
}
console.log(`\n${problems} problem(s)`);
console.log(`CHECK: ${CASES.length} checks · ${problems} failed`);
process.exit(problems ? 1 : 0);
