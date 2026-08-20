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
// Needs a Chrome and a puppeteer, exactly like boot-check; skips if absent.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium"
].find(existsSync);

function loadPuppeteer() {
  for (const base of [
    ROOT,
    "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/",
    "/usr/lib/node_modules/@mermaid-js/mermaid-cli/"
  ]) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}
const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) {
  console.log("session-persistence-check: no puppeteer and/or Chrome found — skipping.");
  process.exit(0);
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
    name: "never signed in here",
    real: "a genuinely new device — the wall is CORRECT here",
    session: "none", stored: false, library: false, expectLogin: true
  }
];

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
    if (CASE.library) {
      localStorage.setItem("flashcards_last_user_id", user.id);
      localStorage.setItem("flashcards_local_decks_index_v1", JSON.stringify([
        { id: "deck-1", name: "Offline deck", updatedAt: new Date(0).toISOString(), cardCount: 1 }
      ]));
    }
  })();`;
}

async function run(base, kase) {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
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
    const ok = got.loginVisible === kase.expectLogin;
    if (!ok) problems++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${kase.name}`);
    console.log(`        ${kase.real}`);
    console.log(`        login wall: ${got.loginVisible} (expected ${kase.expectLogin})` +
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
process.exit(problems ? 1 : 0);
