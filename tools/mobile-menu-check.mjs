// Does the ☰ drawer still open on a phone with a book on screen?
//
//   node tools/mobile-menu-check.mjs
//   node tools/mobile-menu-check.mjs --throttle=1    # unthrottled, for comparison
//   node tools/mobile-menu-check.mjs --chapters=60   # the full 2.5MB book
//
// ── Why this exists next to tools/interaction-scale-check.mjs ──────────────
//
// That check asks the right question ("is the app still ANSWERING once a
// book-sized note is on screen?") and could not see the bug this one was
// written for, in three separate ways. Each is worth stating, because each is a
// way a performance check can be quietly blind:
//
//  1. It runs UNTHROTTLED, and says so deliberately at the top of the file: "a
//     phone is several times slower again". That is a fine thing to assume when
//     the cost being measured is our own script — it scales linearly and a
//     desktop number tells you the phone number. It is NOT fine for style and
//     layout invalidation, where the cost also scales with how much DOM is
//     LAID OUT, and a 390px-wide phone lays out three times the line boxes a
//     desktop does for the same note.
//
//  2. Its fixture is prose — headings, paragraphs and bullets. No images, so
//     sourceMayHaveImages() answers false and the whole image path (a
//     marked.lexer over the entire note on every render tail) is skipped. Real
//     books are not like that.
//
//  3. Its ☰ case waits for `classList.contains("mobile-open")`, which the click
//     handler sets SYNCHRONOUSLY. That is satisfied the instant the handler
//     runs — and the freeze being reported happens entirely AFTER it, while the
//     browser recalculates style for a document with 24,000 blocks in it before
//     it can paint the drawer's first frame. The old case passes throughout.
//
// So this measures the thing a thumb actually experiences: from the press, to
// the first frame the browser manages to produce with the drawer open. It runs
// under a CPU throttle, against a book that has images in it, and it attributes
// the time to style/layout versus script — because the whole reason this hid
// for five commits is that it was never our JavaScript.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const THROTTLE = Number((args.find((a) => a.startsWith("--throttle=")) || "--throttle=6").slice(11));
const VERBOSE = args.includes("--verbose");
// 30 chapters is ~9,700 blocks and ~31,000 elements: comfortably past
// NOTES_CHUNK_MIN_BLOCKS (2,000), so the chunked branch is the one under test,
// and it renders in about a minute under the throttle rather than three. The
// costs this guards were 300-600ms at this size and 550-690ms at 60 chapters —
// both are an order of magnitude past the budgets, so the smaller fixture loses
// nothing but time. --chapters=60 is the book the bug was found on.
const CHAPTERS = Number((args.find((a) => a.startsWith("--chapters=")) || "--chapters=30").slice(11));

// Budgets. The same spirit as interaction-scale-check's: "the app answers a
// finger", not "the app is fast".
//
// firstFrameMs is the load-bearing one and the reason this file exists. It is
// the gap between the drawer's class being set and the browser producing a
// frame — i.e. pure browser work, with no script of ours in it at all. 200ms is
// already twelve frames; anything above that is a visible stall on a control
// that is supposed to slide.
const BUDGET = {
  waitedMs: 250,      // how long the press sat in the queue before any handler ran
  firstFrameMs: 200,  // class set -> first painted frame (style + layout + paint)
  openedMs: 900,      // press -> drawer fully in place (its own slide is 160ms)
  longestFrameMs: 350, // worst frame gap in the second after the press
  // Two pieces of shared UI plumbing that every overlay and every scroll on a
  // phone goes through. Both were whole-document work and are now element-local;
  // 40ms is far above what either should ever cost again, and far below the
  // 550-690ms they cost before.
  scrollLockMs: 40,
  chromeMeasureMs: 40
};

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

// The app's own modules, flattened into one object. Same approach as
// interaction-scale-check's API_SRC: the page has no global API, so the check
// imports what it needs and merges the namespaces.
const API_SRC = `async () => {
  const paths = [
    "/src/render/block-cache.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// ── The fixture: a book, shaped like an imported EPUB ──────────────────────
//
// Deliberately NOT the prose-only book interaction-scale-check builds. An
// imported EPUB carries figures, and one image is enough to change which code
// paths a render tail takes: sourceMayHaveImages() flips, which turns on a
// marked.lexer over the whole note plus a querySelectorAll across every block,
// on every render. A fixture without images tests the cheap branch of the app
// and reports it as the cost of opening a book.
//
// The images are 1x1 data URIs: the point is to be an <img> the renderer has to
// classify, shell and attach a grip to, not to be a picture. Tables, a fenced
// code block and inline math are here for the same reason — each one is a
// different enhancement pass that a prose fixture never reaches.
const SETUP_SRC = `async (apiSrc, CHAPTERS) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("mobile-menu-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Mobile menu fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const out = [];
  for (let c = 0; c < CHAPTERS; c += 1) {
    out.push("# Chapter " + (c + 1) + "\\n");
    for (let s = 0; s < 100; s += 1) {
      out.push("## Section " + (c + 1) + "." + (s + 1) + "\\n");
      out.push("Interaction paragraph " + (s + 1) + " of chapter " + (c + 1) + ". " +
        "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(3) + "\\n");
      out.push("- bullet one\\n- bullet two\\n- bullet three\\n");
      // One figure every ten sections: ~600 images in the book, which is the
      // order a real illustrated EPUB carries.
      if (s % 10 === 0) out.push("![Figure " + (c + 1) + "." + (s + 1) + "](" + PIXEL + ")\\n");
      if (s % 25 === 0) out.push("| Term | Meaning |\\n| --- | --- |\\n| alpha | first |\\n| beta | second |\\n");
      if (s % 25 === 12) out.push("\\\`\\\`\\\`js\\nconst n = " + s + ";\\nexport default n;\\n\\\`\\\`\\\`\\n");
      if (s % 33 === 0) out.push("The bound is $x_{" + s + "} \\\\le n^2$ for every term.\\n");
    }
  }
  window.__recall.md = out.join("\\n");

  const view = document.getElementById("notesView");
  return { width: view ? view.clientWidth : 0, height: view ? view.clientHeight : 0, chars: window.__recall.md.length };
}`;

// Render the book and let its tail land. The chrome is deliberately left
// EXPANDED, and that is not a shortcut — it is the only state in which the ☰
// press being reported is possible at all. While `body.chrome-collapsed` is set
// the appbar carries `pointer-events: none` (styles/12-notes.css:1255), so the
// button is not there to be pressed; the reader gets it back by scrolling up,
// which is where they press it.
const OPEN_BOOK_SRC = `async () => {
  const R = window.__recall;
  const api = R.api;
  api.state.notes = R.md;
  api.setNotesScrolledSource(null);
  api.invalidateRenderedBlockCache();
  const started = performance.now();
  await api.renderNotesView();
  const renderMs = performance.now() - started;
  // Let the render tail (finalizeRenderedSurface, the block estimate, the chunk
  // observers) land before anything is measured: a freeze DURING the render is
  // a different report, already covered by interaction-scale-check.
  await R.settle(3000);
  const view = document.getElementById("notesView");
  return {
    renderMs: Math.round(renderMs),
    blocks: api.notesTopLevelBlocks(view).length,
    chunked: Boolean(view.querySelector(":scope > .notes-chunk")),
    elements: document.querySelectorAll("*").length,
    collapsed: document.body.classList.contains("chrome-collapsed")
  };
}`;

// ── The measurement ────────────────────────────────────────────────────────
//
// Armed before the press, read after it. Four numbers, each answering a
// different half of "the button froze":
//
//   waited          the press sat in the input queue before ANY handler ran.
//                   This is the app being busy with something else.
//   firstFrame      the drawer's class was set, and this is how long the
//                   browser then took to produce a frame. No script of ours
//                   runs in this window: it is style recalculation, layout and
//                   paint. This is the number that was never measured.
//   opened          the press, to the drawer actually standing at x=0.
//   longestFrame    the worst frame gap in the second after the press.
//
// The class write is observed with a MutationObserver rather than by patching
// the handler: the callback is a microtask queued off the attribute change, so
// it timestamps the write without changing what the app does.
//
// Armed fresh before each press, so the same gesture can be measured twice —
// once with an empty note and once with the book open — and the difference
// attributed. That A/B is the whole argument: same throttle, same drawer, same
// press, and the only thing that changed is how much document is sitting in the
// tree while the class flips.
const ARM_SRC = `() => {
  const M = { tapAt: 0, classAt: 0, firstFrameAfterClass: 0, openedAt: 0, longestFrame: 0 };
  window.__menu = M;
  const drawer = document.getElementById("mainToolbar");
  drawer.classList.remove("mobile-open");

  if (!window.__menuArmed) {
    window.__menuArmed = true;
    window.addEventListener("pointerdown", (e) => {
      const M2 = window.__menu;
      if (M2 && !M2.tapAt) M2.tapAt = { at: performance.now(), waited: performance.now() - e.timeStamp };
    }, { capture: true });

    new MutationObserver(() => {
      const M2 = window.__menu;
      if (!M2 || M2.classAt) return;
      if (drawer.classList.contains("mobile-open")) M2.classAt = performance.now();
    }).observe(drawer, { attributes: true, attributeFilter: ["class"] });

    let last = performance.now();
    const tick = () => {
      const M2 = window.__menu;
      const now = performance.now();
      const gap = now - last;
      last = now;
      if (M2) {
        if (M2.tapAt && gap > M2.longestFrame) M2.longestFrame = gap;
        if (M2.classAt && !M2.firstFrameAfterClass && now > M2.classAt) M2.firstFrameAfterClass = now - M2.classAt;
        if (M2.classAt && !M2.openedAt && drawer.getBoundingClientRect().left > -1) M2.openedAt = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  const r = document.getElementById("mobileMenuBtn").getBoundingClientRect();
  const style = getComputedStyle(document.querySelector(".appbar"));
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    // A collapsed appbar is pointer-events: none, so the button would not be
    // reachable and the whole measurement would be of nothing.
    reachable: r.width > 0 && r.height > 0 && style.pointerEvents !== "none" && style.opacity !== "0"
  };
}`;

const READ_SRC = `() => {
  const M = window.__menu;
  if (!M || !M.tapAt) return null;
  return {
    waited: Math.round(M.tapAt.waited),
    firstFrame: M.firstFrameAfterClass ? Math.round(M.firstFrameAfterClass) : -1,
    opened: M.openedAt ? Math.round(M.openedAt - M.tapAt.at) : -1,
    longestFrame: Math.round(M.longestFrame),
    open: document.getElementById("mainToolbar").classList.contains("mobile-open")
  };
}`;

// ── The two pieces of shared plumbing, timed directly ─────────────────────
//
// The gesture cases above are what a reader feels, and they are noisy: a press
// carries a transition, a paint and whatever else the page was doing. These two
// are the mechanisms underneath, timed on their own with a forced flush, so a
// regression names itself instead of showing up as "the drawer felt slow".
//
// Both were found by bisecting the press one write at a time (see the header),
// and both were whole-document work triggered from a control that has nothing
// to do with the note:
//
//   lockPageScroll()   puts overflow:hidden on <html> and position:fixed on
//                      <body>, which makes the root a different scrolling box
//                      and re-lays out everything behind the overlay. Every
//                      panel, modal and prompt in the app calls it.
//   readChromeHeights() published --appbar-h / --view-toggle-h on :root, where
//                      every element in the document inherits them, so the whole
//                      tree had to re-resolve its variables. It runs on every
//                      chrome fold and on every tick of the ResizeObserver that
//                      watches the appbar while a phone reader scrolls.
const PLUMBING_SRC = `async () => {
  const overlays = await import("/src/ui/overlays.js?v=__BUILD__");
  const chrome = await import("/src/ui/chrome.js?v=__BUILD__");
  const flush = () => document.body.offsetHeight;
  const time = (fn) => { const t = performance.now(); fn(); flush(); return performance.now() - t; };
  const worst = { lock: 0, unlock: 0, measure: 0 };
  for (let i = 0; i < 3; i += 1) {
    worst.lock = Math.max(worst.lock, time(() => overlays.lockPageScroll()));
    worst.unlock = Math.max(worst.unlock, time(() => overlays.unlockPageScroll()));
    worst.measure = Math.max(worst.measure, time(() => chrome.readChromeHeights()));
  }
  return {
    lock: Math.round(worst.lock),
    unlock: Math.round(worst.unlock),
    measure: Math.round(worst.measure),
    canScroll: overlays.pageCanScroll(),
    stillLocked: document.documentElement.classList.contains("modal-scroll-lock")
  };
}`;

// Shut the drawer again between presses, through the app's own close path, so
// the second press starts from the state the first one did.
const CLOSE_SRC = `() => {
  const btn = document.getElementById("toolbarCloseBtn");
  if (btn) btn.click();
  return document.getElementById("mainToolbar").classList.contains("mobile-open");
}`;

// Cumulative renderer counters, differenced across the press. This is the
// attribution the longtask observer cannot give: a 900ms task tells you the
// thread was blocked, not that 840ms of it was style recalculation.
async function metrics(page) {
  const { metrics: list } = await page.call("Performance.getMetrics");
  const pick = (name) => list.find((m) => m.name === name)?.value ?? 0;
  return {
    script: pick("ScriptDuration"),
    style: pick("RecalcStyleDuration"),
    layout: pick("LayoutDuration"),
    task: pick("TaskDuration")
  };
}

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("mobile-menu-check: no Chrome on this machine — skipping.");
    return 0;
  }

  const server = await serveOn(ROOT);
  let browser = null;
  let client = null;
  const errors = [];
  try {
    browser = await launchChrome(chrome);
    client = await connect(browser.wsUrl);
    const page = await openPage(client);
    await emulatePhone(page, { width: 390, height: 844, cpuThrottle: THROTTLE });
    await page.call("Performance.enable");
    // The app asks a CDN for nothing it cannot do without, and a check that
    // waits on the network measures the network.
    await page.call("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*"] });
    client.on((message) => {
      if (message.sessionId !== page.sessionId) return;
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || "unknown");
      }
    });

    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "boot" });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      console.log("mobile-menu-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await new Promise((r) => setTimeout(r, 2500));

    const setup = await page.evaluate(new Function(`return (${SETUP_SRC})`)(), API_SRC, CHAPTERS);
    if (!setup || setup.width < 200 || setup.height < 200) {
      console.log(`mobile-menu-check: #notesView is ${setup ? `${setup.width}x${setup.height}` : "missing"} — nothing below would mean anything`);
      return 1;
    }

    // One press, measured end to end, with the renderer's own counters
    // differenced across it.
    const pressMenu = async () => {
      const armed = await page.evaluate(new Function(`return (${ARM_SRC})`)());
      if (!armed.reachable) return { armed, measured: null, spent: null };
      const before = await metrics(page);
      await page.tap(armed.x, armed.y);
      // Long enough for the drawer's own 160ms slide plus anything in front of
      // it. The reported stall is seconds, so this must not be the thing that
      // ends the measurement.
      await new Promise((r) => setTimeout(r, 6000));
      const after = await metrics(page);
      const measured = await page.evaluate(new Function(`return (${READ_SRC})`)());
      const spent = {
        script: Math.round((after.script - before.script) * 1000),
        style: Math.round((after.style - before.style) * 1000),
        layout: Math.round((after.layout - before.layout) * 1000),
        task: Math.round((after.task - before.task) * 1000)
      };
      await page.evaluate(new Function(`return (${CLOSE_SRC})`)());
      await new Promise((r) => setTimeout(r, 800));
      return { armed, measured, spent };
    };

    // ── The control ────────────────────────────────────────────────────────
    // The same press, on the same phone, at the same throttle, with an empty
    // note. Whatever this costs is what the drawer costs; everything the book
    // press costs above it is the note's doing.
    const stage = (what) => { if (VERBOSE) console.error(`  … ${what}`); };
    stage("pressing ☰ with an empty note");
    const control = await pressMenu();

    stage("rendering the book");
    const book = await page.evaluate(new Function(`return (${OPEN_BOOK_SRC})`)());
    stage(`book rendered in ${book.renderMs}ms — pressing ☰ again`);
    const loaded = await pressMenu();

    stage("timing the shared overlay/chrome plumbing");
    const plumbing = await page.evaluate(new Function(`return (${PLUMBING_SRC})`)());

    const results = [];
    const push = (name, ok, detail, measured) => results.push({ name, ok, detail, measured });
    const m = loaded.measured;
    const spent = loaded.spent || { script: 0, style: 0, layout: 0, task: 0 };

    push("the fixture is a book, with figures in it",
      book.blocks >= 2000 && book.chunked,
      `${book.blocks} blocks, ${(setup.chars / 1e6).toFixed(1)}MB, chunked ${book.chunked}, ${book.elements} elements`,
      `rendered in ${book.renderMs}ms at ${THROTTLE}x throttle`);

    push("the ☰ button is reachable with the book open",
      Boolean(loaded.armed.reachable),
      "the appbar was collapsed or invisible, so no press could land on it",
      loaded.armed.reachable ? `at ${loaded.armed.x},${loaded.armed.y}` : "");

    if (!m) {
      push("the ☰ press reaches the app", false, "the press was never delivered", "");
    } else {
      push("the ☰ press reaches the app promptly",
        m.waited >= 0 && m.waited <= BUDGET.waitedMs,
        `the press waited ${m.waited}ms for the main thread`,
        `${m.waited}ms (empty note ${control.measured?.waited ?? "n/a"}ms)`);
      push("the drawer paints a frame once it is opened",
        m.firstFrame >= 0 && m.firstFrame <= BUDGET.firstFrameMs,
        m.firstFrame < 0
          ? "the drawer never opened"
          : `${m.firstFrame}ms of browser work between the class being set and the first frame`,
        `${m.firstFrame}ms (empty note ${control.measured?.firstFrame ?? "n/a"}ms)`);
      push("the drawer finishes sliding in",
        m.opened >= 0 && m.opened <= BUDGET.openedMs,
        m.opened < 0 ? "the drawer never reached the screen" : `${m.opened}ms from the press`,
        `${m.opened}ms (empty note ${control.measured?.opened ?? "n/a"}ms)`);
      push("nothing drops a frame for longer than a blink",
        m.longestFrame <= BUDGET.longestFrameMs,
        `worst frame gap ${m.longestFrame}ms`,
        `${m.longestFrame}ms (empty note ${control.measured?.longestFrame ?? "n/a"}ms)`);
    }

    push("opening an overlay does not re-lay out the note",
      plumbing.lock <= BUDGET.scrollLockMs && plumbing.unlock <= BUDGET.scrollLockMs && !plumbing.stillLocked,
      plumbing.stillLocked
        ? "the scroll lock was left held"
        : `lockPageScroll ${plumbing.lock}ms / unlockPageScroll ${plumbing.unlock}ms — every panel, modal and prompt pays this twice`,
      `lock ${plumbing.lock}ms, unlock ${plumbing.unlock}ms (page ${plumbing.canScroll ? "can" : "cannot"} scroll)`);

    push("measuring the chrome does not re-resolve the whole document",
      plumbing.measure <= BUDGET.chromeMeasureMs,
      `readChromeHeights ${plumbing.measure}ms — this runs on every chrome fold and every ResizeObserver tick while a phone scrolls`,
      `${plumbing.measure}ms`);

    push("the page threw nothing", errors.length === 0, errors[0] || "", "");

    const failed = results.filter((r) => !r.ok);
    results.forEach((r) => {
      const mark = r.ok ? "ok  " : "FAIL";
      console.log(`${mark} ${r.name}${r.measured ? `  [${r.measured}]` : ""}`);
      // Only on failure. `detail` is written as the reason a case FAILED, so
      // printing it under a passing case reads as a contradiction.
      if (!r.ok && r.detail) console.log(`       ${r.detail}`);
    });
    const c = control.spent;
    console.log(`\nAcross the press, at ${THROTTLE}x CPU throttle:`);
    if (c) {
      console.log(`  empty note   task ${c.task}ms   style ${c.style}ms   layout ${c.layout}ms   script ${c.script}ms`);
    }
    console.log(`  book open    task ${spent.task}ms   style ${spent.style}ms   layout ${spent.layout}ms   script ${spent.script}ms`);
    return failed.length ? 1 : 0;
  } finally {
    client?.close();
    browser?.close();
    server.proc.kill();
  }
}

process.exit(await run());
