// Does the teleprompter do what it says, in a real browser?
//
//   node tools/teleprompter-check.mjs            run the cases
//   node tools/teleprompter-check.mjs --shot     also save teleprompter.png
//
// The teleprompter (src/notes/teleprompter.js) scrolls a note by itself under a
// reading band, at a speed in words a minute. The promise it makes is in the
// order of these cases: it starts from the ⋯ menu and says so; the text moves,
// at about the speed it says, and faster when asked; a press on the text stops
// it in the same tick, because touch-selection cancels a long-press whose text
// moves under the finger; paused, the note is the note — same type, no band,
// selectable — and the bar gets out of the way of a selection; ▶ carries on
// from wherever the text is NOW; it can carry on by itself, but never over a
// selection; Escape gives back the Notes text exactly as it was; paged mode is
// suspended while it runs and returned after; the end of the note is said, not
// silently sat at; another tab pauses it and the raw editor ends it; and on a
// phone the bar fits.
//
// Same harness as notes-menu-check: the app's own modules imported into the
// page, a fake Supabase client, one fixture file created and opened in Notes.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SHOT = (args.find((a) => a.startsWith("--shot=")) || "").slice(7)
  || (args.includes("--shot") ? "teleprompter.png" : "");

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
  const paths = [
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/notes/teleprompter.js?v=__BUILD__",
    "/src/notes/paged-view.js?v=__BUILD__",
    "/src/core/gesture.js?v=__BUILD__",
    "/src/notes/touch-selection.js?v=__BUILD__",
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

// An article: a heading and a hundred and twenty paragraphs of plain prose, so
// the words-per-pixel the teleprompter measures is the same all the way down.
const SENTENCE = "The reader follows the line in the band while the text rises at the pace they chose, and nothing else on the page asks for their attention";
const FIXTURE = [
  "# An imported article",
  "",
  ...Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}. ${SENTENCE}. ${SENTENCE.toLowerCase()} once more, so the paragraph wraps onto several lines.\n`)
].join("\n");

const SETUP_SRC = `async (apiSrc, fixture) => {
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
    from: () => { throw new Error("teleprompter-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Teleprompter fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(300);
  api.state.notes = fixture;
  api.setNotesScrolledSource(null);
  await api.renderNotesView();
  await settle(600);
  return document.querySelectorAll("#notesView p").length;
}`;

const chrome = findChrome();
if (!chrome) { console.log("teleprompter-check: no Chrome on this machine — skipping."); process.exit(0); }

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function emulateDesktop() {
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 860, deviceScaleFactor: 1, mobile: false
  });
}

const failures = [];
let ran = 0;
async function check(name, fn) {
  ran += 1;
  let detail = null;
  try { detail = await fn(); } catch (error) { detail = String(error.message || error); }
  if (detail) failures.push({ name, detail });
  console.log(`${detail ? "FAIL" : "ok  "}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const snap = () => page.evaluate(`() => window.__recall.api.teleprompterSnapshot()`);

// How far the note scrolled over `ms`, measured in the page on the page's clock.
const rateOver = (ms) => page.evaluate(`async (ms) => {
  const view = document.getElementById("notesView");
  const t0 = performance.now();
  const y0 = view.scrollTop;
  await new Promise((r) => setTimeout(r, ms));
  return (view.scrollTop - y0) / ((performance.now() - t0) / 1000);
}`, ms);

// A real press on a paragraph through the browser's own input pipeline, with
// the session's phase read back BEFORE the button comes up: the stop has to
// have landed by then.
async function pressText() {
  const point = await page.evaluate(`() => {
    const view = document.getElementById("notesView");
    const box = view.getBoundingClientRect();
    const y = box.top + box.height * 0.6;
    const p = [...view.querySelectorAll("p")].find((n) => {
      const r = n.getBoundingClientRect();
      return r.top < y && r.bottom > y;
    });
    const r = (p || view).getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(80, r.width / 3)), y: Math.round(y) };
  }`);
  await page.call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  const during = await snap();
  await page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  return during;
}

async function key(keyName, code, keyCode) {
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: keyCode });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode });
}

const waitPhase = (phase, timeout = 6000) => page.waitFor(
  `() => window.__recall.api.teleprompterSnapshot()?.phase === ${JSON.stringify(phase)}`,
  { timeout, label: `the teleprompter to be ${phase}` }
);

const READ_TYPE = `() => {
  const view = document.getElementById("notesView");
  return {
    size: parseFloat(getComputedStyle(view).fontSize),
    inline: ["--notes-font-size", "--notes-line-height", "--notes-max-width", "--notes-font-family", "--tp-lead", "--tp-runout"]
      .filter((name) => view.style.getPropertyValue(name)),
    cls: view.classList.contains("is-teleprompter")
  };
}`;

let notesSize = 0;

try {
  await emulateDesktop();
  await page.goto(`${server.base}/index.html`);
  const paragraphs = await page.evaluate(SETUP_SRC, API_SRC, FIXTURE);
  if (paragraphs < 100) throw new Error(`fixture rendered ${paragraphs} paragraphs`);
  notesSize = (await page.evaluate(READ_TYPE)).size;

  // ── Starting it ──────────────────────────────────────────────────────────
  await check("⋯ → Teleprompter is a switch that reads Off, and pressing it opens a session", async () => {
    const before = await page.evaluate(`() => {
      const menu = document.getElementById("notesHeadMoreMenu");
      if (menu.hidden) document.getElementById("notesHeadMoreBtn").click();
      const row = menu.querySelector("#teleprompterBtn");
      return row ? { pressed: row.getAttribute("aria-pressed"), label: row.querySelector(".nhm-label")?.textContent || "" } : null;
    }`);
    if (!before) return "no Teleprompter row in the ⋯ menu";
    if (before.pressed !== "false") return `the row reads aria-pressed=${before.pressed} with nothing running`;
    if (!before.label.includes("Teleprompter")) return `the row is labelled "${before.label}"`;
    await page.evaluate(`() => document.getElementById("teleprompterBtn").click()`);
    await sleep(250);
    const after = await page.evaluate(`() => {
      const bar = document.querySelector("#notesStage > .tp-bar");
      const box = bar?.getBoundingClientRect();
      return {
        active: window.__recall.api.teleprompterActive(),
        pressed: document.getElementById("teleprompterBtn").getAttribute("aria-pressed"),
        rail: document.querySelector('#readingRailTray [data-rail-action="teleprompter"]')?.getAttribute("aria-pressed"),
        bar: box ? box.width > 100 && box.height > 30 : false,
        phase: window.__recall.api.teleprompterSnapshot()?.phase,
        count: document.querySelector(".tp-countdown")?.hidden === false
      };
    }`);
    if (!after.active) return "pressing the row did not start a session";
    if (after.pressed !== "true") return "the switch still reads Off";
    if (after.rail !== "true") return `the rail's copy reads ${after.rail}`;
    if (!after.bar) return "no bar on screen";
    if (after.phase !== "countdown" || !after.count) return `expected the default 3-second countdown, saw phase ${after.phase}`;
    return null;
  });

  await check("the note takes the teleprompter's type; Notes' own setting is untouched", async () => {
    const seen = await page.evaluate(`() => ({
      view: parseFloat(getComputedStyle(document.getElementById("notesView")).fontSize),
      root: getComputedStyle(document.documentElement).getPropertyValue("--notes-font-size").trim(),
      snap: window.__recall.api.teleprompterSnapshot()
    })`);
    if (Math.abs(seen.view - seen.snap.fontSize) > 0.5) return `the note is ${seen.view}px, the session says ${seen.snap.fontSize}px`;
    if (seen.snap.fontSize <= notesSize) return `the default size ${seen.snap.fontSize}px is not larger than Notes' ${notesSize}px`;
    if (Math.abs(parseFloat(seen.root) - notesSize) > 0.5) return `the root's --notes-font-size changed to ${seen.root}`;
    return null;
  });

  await check("the countdown hands over and the text moves at about the speed it says", async () => {
    await waitPhase("playing", 5000);
    await sleep(900);
    const rate = await rateOver(2000);
    const s = await snap();
    if (!(rate > 1)) return `the note moved ${rate.toFixed(2)}px/s while playing`;
    const ratio = rate / s.pxPerSecond;
    if (ratio < 0.6 || ratio > 1.4) return `moved ${rate.toFixed(1)}px/s, the session asked for ${s.pxPerSecond.toFixed(1)}px/s`;
    const flag = await page.evaluate(`() => window.__recall.api.notesAutoScrolling()`);
    if (!flag) return "notesAutoScrolling() is false while it plays — the correction loops would fight it";
    return null;
  });

  await check("twice the words a minute is about twice the speed", async () => {
    const s = await snap();
    const slow = await rateOver(1500);
    const presses = Math.round(s.wpm / 10);
    for (let i = 0; i < presses; i += 1) await key("ArrowUp", "ArrowUp", 38);
    const doubled = await snap();
    if (doubled.wpm !== Math.min(600, s.wpm * 2)) return `↑ x${presses} took ${s.wpm} wpm to ${doubled.wpm}`;
    await sleep(300);
    const fast = await rateOver(1500);
    const ratio = fast / slow;
    if (ratio < 1.5 || ratio > 2.6) return `${s.wpm} → ${doubled.wpm} wpm moved ${slow.toFixed(1)} → ${fast.toFixed(1)}px/s`;
    for (let i = 0; i < presses; i += 1) await key("ArrowDown", "ArrowDown", 40);
    return null;
  });

  // ── Interrupting it ──────────────────────────────────────────────────────
  let pausedAt = 0;
  await check("a press on the text stops it before the button comes up, and it stays stopped", async () => {
    const during = await pressText();
    if (during?.phase !== "paused") return `mid-press the session was ${during?.phase}`;
    if (during.pauseReason !== "reader") return `paused for "${during.pauseReason}", expected "reader"`;
    pausedAt = await page.evaluate(`() => document.getElementById("notesView").scrollTop`);
    await sleep(600);
    const later = await page.evaluate(`() => document.getElementById("notesView").scrollTop`);
    if (Math.abs(later - pausedAt) > 1) return `the text moved ${(later - pausedAt).toFixed(1)}px after the press`;
    const flag = await page.evaluate(`() => window.__recall.api.notesAutoScrolling()`);
    if (flag) return "notesAutoScrolling() is still true while paused";
    return null;
  });

  await check("paused, the note is the note: same type, no band, selectable — and the bar steps aside", async () => {
    const type = await page.evaluate(READ_TYPE);
    const s = await snap();
    if (Math.abs(type.size - s.fontSize) > 0.5) return `paused at ${type.size}px — the type changed under the reader`;
    const seen = await page.evaluate(`async () => {
      const overlay = document.querySelector(".tp-overlay");
      const view = document.getElementById("notesView");
      const box = view.getBoundingClientRect();
      const p = [...view.querySelectorAll("p")].find((n) => n.getBoundingClientRect().top > box.top + 40);
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      await new Promise((r) => setTimeout(r, 700));
      const tucked = document.querySelector(".tp-bar").classList.contains("is-tucked");
      const text = String(getSelection()).trim().length;
      sel.removeAllRanges();
      await new Promise((r) => setTimeout(r, 600));
      return {
        opacity: getComputedStyle(overlay).opacity,
        tucked,
        text,
        back: !document.querySelector(".tp-bar").classList.contains("is-tucked")
      };
    }`);
    if (seen.opacity !== "0") return `the band is still showing while paused (opacity ${seen.opacity})`;
    if (!seen.text) return "could not select text in the paused note";
    if (!seen.tucked) return "the bar stayed up over a live selection";
    if (!seen.back) return "the bar did not come back once the selection was gone";
    return null;
  });

  await check("▶ Resume carries on from where the text is now, not where it stopped", async () => {
    const moved = await page.evaluate(`() => {
      const view = document.getElementById("notesView");
      view.scrollTop += 600;
      return view.scrollTop;
    }`);
    await sleep(150);
    await page.evaluate(`() => document.querySelector(".tp-bar .tp-play").click()`);
    await waitPhase("playing", 2000);
    await sleep(1200);
    const now = await page.evaluate(`() => document.getElementById("notesView").scrollTop`);
    if (now <= moved) return `resumed and went from ${moved} to ${now}`;
    if (now - pausedAt < 500) return `resumed from where it paused (${pausedAt}) rather than where the reader scrolled to (${moved})`;
    return null;
  });

  await check("Space pauses and carries on; ↓ makes it slower", async () => {
    const before = await snap();
    await key(" ", "Space", 32);
    await sleep(100);
    const paused = await snap();
    if (paused.phase !== "paused" || paused.pauseReason !== "button") return `Space left it ${paused.phase} (${paused.pauseReason})`;
    await key(" ", "Space", 32);
    await sleep(100);
    if ((await snap()).phase !== "playing") return "a second Space did not carry on";
    await key("ArrowDown", "ArrowDown", 40);
    const slower = await snap();
    if (slower.wpm !== before.wpm - 10) return `↓ took ${before.wpm} to ${slower.wpm} wpm`;
    await key("ArrowUp", "ArrowUp", 38);
    return null;
  });

  await check("Carry on by itself waits out a selection, then carries on", async () => {
    await page.evaluate(`() => {
      document.querySelector(".tp-bar .tp-settings").click();
      document.querySelector('[data-tp-choice="autoResume"][data-tp-choice-value="3"]').click();
      document.querySelector(".tp-sheet .tp-sheet-close").click();
    }`);
    const during = await pressText();
    if (during?.phase !== "paused") return `the press left it ${during?.phase}`;
    await page.evaluate(`() => {
      const view = document.getElementById("notesView");
      const box = view.getBoundingClientRect();
      const p = [...view.querySelectorAll("p")].find((n) => n.getBoundingClientRect().top > box.top + 40);
      const range = document.createRange();
      range.selectNodeContents(p);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }`);
    await sleep(3800);
    if ((await snap()).phase !== "paused") return "it carried on with text still selected";
    await page.evaluate(`() => getSelection().removeAllRanges()`);
    await waitPhase("playing", 5500);
    const stored = await page.evaluate(`() => JSON.parse(localStorage.getItem("recall:teleprompter-v1") || "null")`);
    if (stored?.autoResume !== 3) return `the setting was not kept (stored: ${JSON.stringify(stored)})`;
    await page.evaluate(`() => {
      document.querySelector(".tp-bar .tp-settings").click();
      document.querySelector('[data-tp-choice="autoResume"][data-tp-choice-value="0"]').click();
      document.querySelector(".tp-sheet .tp-sheet-close").click();
    }`);
    return null;
  });

  if (SHOT) {
    await sleep(800);
    const shot = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.resolve(ROOT, SHOT), Buffer.from(shot.data, "base64"));
    console.log(`      screenshot → ${SHOT}`);
  }

  // ── Leaving it ───────────────────────────────────────────────────────────
  await check("Escape leaves, and the Notes text is exactly as it was", async () => {
    await key("Escape", "Escape", 27);
    await sleep(300);
    const seen = await page.evaluate(`() => ({
      active: window.__recall.api.teleprompterActive(),
      pressed: document.getElementById("teleprompterBtn").getAttribute("aria-pressed"),
      bar: Boolean(document.querySelector(".tp-bar, .tp-overlay, .tp-sheet")),
      focus: window.__recall.api.isFocusModeActive(),
      flag: window.__recall.api.notesAutoScrolling()
    })`);
    const type = await page.evaluate(READ_TYPE);
    if (seen.active) return "Escape did not leave";
    if (seen.pressed !== "false") return "the ⋯ switch still reads On";
    if (seen.bar) return "the bar, band or sheet is still in the page";
    if (Math.abs(type.size - notesSize) > 0.5) return `the note is ${type.size}px after leaving, Notes is ${notesSize}px`;
    if (type.inline.length || type.cls) return `left behind on the note: ${type.inline.join(", ") || "the is-teleprompter class"}`;
    if (seen.focus) return "focus mode, which the teleprompter turned on, is still on";
    if (seen.flag) return "notesAutoScrolling() is still true";
    return null;
  });

  await check("paged mode is suspended while it runs and comes back after", async () => {
    const seen = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const view = document.getElementById("notesView");
      api.setNotesReadingMode("paged-1");
      await settle(300);
      const before = api.isNotesPaged();
      api.toggleTeleprompter();
      await settle(400);
      const during = { paged: api.isNotesPaged(), cls: view.classList.contains("is-paged") };
      api.exitTeleprompter();
      await settle(400);
      const after = { paged: api.isNotesPaged(), cls: view.classList.contains("is-paged") };
      api.setNotesReadingMode("continuous");
      await settle(300);
      return { before, during, after };
    }`);
    if (!seen.before) return "could not put the note in paged mode to test this";
    if (seen.during.paged || seen.during.cls) return "the note stayed paged with the teleprompter running";
    if (!seen.after.paged || !seen.after.cls) return "paged mode did not come back on leaving";
    return null;
  });

  // Countdowns off from here: they are covered above and only cost time.
  await page.evaluate(`() => {
    const stored = JSON.parse(localStorage.getItem("recall:teleprompter-v1") || "{}");
    localStorage.setItem("recall:teleprompter-v1", JSON.stringify({ ...stored, countdown: 0 }));
  }`);

  await check("the settings were kept, and a new session starts from them", async () => {
    // The cached copy is the module's; a reload is what proves it is stored.
    await page.goto(`${server.base}/index.html`);
    await page.evaluate(SETUP_SRC, API_SRC, FIXTURE);
    const seen = await page.evaluate(`async () => {
      window.__recall.api.toggleTeleprompter();
      await window.__recall.settle(200);
      return window.__recall.api.teleprompterSnapshot();
    }`);
    if (!seen) return "no session after the reload";
    if (seen.settings.countdown !== 0) return `countdown came back as ${seen.settings.countdown}`;
    if (seen.phase !== "playing") return `with no countdown it started ${seen.phase}`;
    return null;
  });

  await check("the end of the note is said, and ↺ starts it again from the top", async () => {
    await page.evaluate(`() => {
      const view = document.getElementById("notesView");
      view.scrollTop = view.scrollHeight;
    }`);
    await waitPhase("ended", 6000);
    const end = await page.evaluate(`() => {
      const box = document.querySelector(".tp-bar .tp-end")?.getBoundingClientRect();
      return { shown: Boolean(box && box.width > 0), text: document.querySelector(".tp-end-text")?.textContent };
    }`);
    if (!end.shown) return "the bar does not show the end";
    await page.evaluate(`() => document.querySelector(".tp-bar .tp-again").click()`);
    await sleep(200);
    const top = await page.evaluate(`() => document.getElementById("notesView").scrollTop`);
    const s = await snap();
    if (top > 50) return `↺ left the note at ${top}px`;
    if (s.phase !== "playing" && s.phase !== "countdown") return `↺ left it ${s.phase}`;
    return null;
  });

  await check("another tab pauses it, and coming back finds it waiting", async () => {
    const seen = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("cards");
      await settle(500);
      const away = api.teleprompterSnapshot();
      api.setViewMode("notes");
      await settle(500);
      return { away, back: api.teleprompterSnapshot() };
    }`);
    if (!seen.away) return "switching to Cards ended the session";
    if (seen.away.phase !== "paused" || seen.away.pauseReason !== "away") return `on Cards it was ${seen.away.phase} (${seen.away.pauseReason})`;
    if (seen.back?.phase !== "paused") return `back on Notes it was ${seen.back?.phase}`;
    return null;
  });

  await check("the raw editor ends it", async () => {
    const seen = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.enterNotesEditing(0);
      await settle(500);
      const active = api.teleprompterActive();
      api.commitNotesEditIfActive();
      await settle(400);
      return { active, type: parseFloat(getComputedStyle(document.getElementById("notesView")).fontSize) };
    }`);
    if (seen.active) return "the session is still open in the raw editor";
    if (Math.abs(seen.type - notesSize) > 0.5) return `back from the editor the note is ${seen.type}px, Notes is ${notesSize}px`;
    return null;
  });

  // ── A phone ──────────────────────────────────────────────────────────────
  //
  // Loaded at phone size, so the app's own touch selection is armed the way it
  // is on a real phone rather than switched to halfway through.
  await emulatePhone(page, { width: 390, height: 844 });
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC, FIXTURE);

  await check("on a phone, a long-press on the moving text selects on the first try", async () => {
    await page.evaluate(`() => window.__recall.api.toggleTeleprompter()`);
    await waitPhase("playing", 3000);
    await sleep(1200);
    const point = await page.evaluate(`() => {
      const view = document.getElementById("notesView");
      const box = view.getBoundingClientRect();
      const y = box.top + box.height * 0.55;
      const p = [...view.querySelectorAll("p")].find((n) => {
        const r = n.getBoundingClientRect();
        return r.top < y - 20 && r.bottom > y + 20;
      });
      const r = p.getBoundingClientRect();
      return { x: Math.round(r.left + r.width * 0.4), y: Math.round(y) };
    }`);
    await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, radiusX: 6, radiusY: 6, force: 1 }] });
    const during = await snap();
    await sleep(900);
    await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(400);
    const seen = await page.evaluate(`() => {
      const range = window.__recall.api.touchSelectionRange?.();
      return {
        armed: document.body.classList.contains("has-touch-select"),
        text: range ? String(range).trim() : String(getSelection()).trim()
      };
    }`);
    if (during?.phase !== "paused") return `the touch left it ${during?.phase}`;
    if (!seen.text) return `nothing was selected after the long-press (touch selection armed: ${seen.armed})`;
    return null;
  });

  await check("on a phone the bar fits the width, every control a thumb wide", async () => {
    const seen = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      if (!api.teleprompterActive()) api.toggleTeleprompter();
      await settle(400);
      const bar = document.querySelector(".tp-bar");
      const box = bar.getBoundingClientRect();
      const small = [...bar.querySelectorAll("button")]
        .filter((b) => b.getBoundingClientRect().width > 0)
        .filter((b) => b.getBoundingClientRect().height < 36 || b.getBoundingClientRect().width < 36)
        .map((b) => b.getAttribute("aria-label") || b.textContent);
      const out = {
        left: box.left, right: box.right, width: innerWidth,
        overflow: bar.scrollWidth - bar.clientWidth,
        page: document.documentElement.scrollWidth - innerWidth,
        small
      };
      api.exitTeleprompter();
      return out;
    }`);
    if (seen.left < 0 || seen.right > seen.width + 0.5) return `the bar runs from ${seen.left} to ${seen.right} on a ${seen.width}px screen`;
    if (seen.overflow > 1) return `the bar's controls overflow it by ${seen.overflow}px`;
    if (seen.page > 1) return `the page scrolls sideways by ${seen.page}px`;
    if (seen.small.length) return `too small to press: ${seen.small.join(", ")}`;
    return null;
  });
} finally {
  client.close();
  launched.close();
  server.proc.kill();
}

console.log(failures.length
  ? `\n${failures.length} of ${ran} teleprompter case(s) failed.`
  : `\n${ran} teleprompter cases, all clean.`);
console.log(`CHECK: ${ran} checks · ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
