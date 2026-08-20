// Does selecting and highlighting still work on a note big enough to be CHUNKED?
//
//   node tools/large-note-selection-check.mjs
//   node tools/large-note-selection-check.mjs --throttle=4
//
// tools/touch-selection-check.mjs drives the app's own touch selection end to
// end and says so in its own header: "Deliberately small: nothing here is about
// render scale, and a book-sized fixture would make the timing case measure the
// renderer instead of the press." That was the right call for what it asserts,
// and it is also the hole this file fills — because every one of the three
// things reported here happens ONLY past NOTES_CHUNK_MIN_BLOCKS:
//
//   • "text selection invocation is shit" — a long press that has to be
//     repeated. On a chunked note the reading surface's scrollTop moves without
//     the content moving: the browser's scroll anchoring compensates whenever
//     something above the viewport changes height, which is what
//     measureNotesChunkEstimate does to every chunk entering its runway. The
//     press-cancel test was measuring scrollTop, so it cancelled presses on a
//     page the reader could see was perfectly still.
//
//   • "the text selection seems buggy" — a drag that moves the words. Freeing
//     `content-visibility` on the chunk under the selection is what keeps the
//     text still while a handle is on it, and it was ALSO what moved the text:
//     an unmeasured chunk is standing at its contain-intrinsic-size estimate and
//     jumps to its real height the moment containment comes off.
//
//   • "after selecting when I highlight I see a violent shaking" — the repaint
//     re-lexed the whole note, and settleNotesPin then wrote scrollTop over and
//     over chasing what that repaint had displaced.
//
// So the assertions here are the symptoms, as numbers: how long a press takes
// when the note is still settling, how far the text under the finger MOVES
// across a chunk boundary, and how many pixels the note travels in the two
// seconds after a highlight lands. That last one has never been measured
// anywhere and it should be zero.
//
// ── What this file does NOT cover, and where that lives ────────────────────
//
// The fixture is a chunked note, not a book: ~284KB and 71 chunks, which is
// past every threshold that changes behaviour (NOTES_CHUNK_MIN_BLOCKS,
// NOTES_PARSE_CHUNK_MIN_CHARS, NOTES_INCREMENTAL_SPLIT_MIN_CHARS) and small
// enough to render in about a second. The COST of those paths at book scale —
// what a highlight costs on 2.4MB, whether the block array is patched rather
// than re-lexed, whether locating a selection searches a window — is measured in
// tools/interaction-scale-check.mjs against a fixture ten times this size. This
// file is about the gesture: that a finger can still start, extend and act on a
// selection once chunking is switched on, which nothing else drives at all.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THROTTLE = Number((process.argv.find((a) => a.startsWith("--throttle=")) || "--throttle=1").slice(11)) || 1;

// Budgets. Generous, like the ones in tools/interaction-scale-check.mjs: these
// say "the app answers a finger", not "the app is fast".
const PRESS_MS = 240 * THROTTLE + 600;   // LONG_PRESS_MS plus room to be delivered

// How far the text may move under a resting or dragging finger.
//
// Not zero, and the reason is measured rather than assumed: on this fixture the
// paragraph under the finger drifts ~30-50px during a gesture that follows a
// scroll into content the reader has not seen, and it does so IDENTICALLY on the
// build before any of this work and on the build after — it is the browser's own
// `content-visibility` settling, not something the app does. Asserting zero would
// be asserting something no version of this app has ever done.
//
// What the budget is FOR is the failure mode that is the app's: an unmeasured
// chunk swapping a guessed placeholder for its real height mid-gesture moves the
// document by a whole chunk's worth of error — hundreds to thousands of pixels,
// which is what "the indicators are almost always wrong" was made of. 120px sits
// well above the settling and far below that.
const DRIFT_PX = 120;

// Total scroll TRAVEL in the two seconds after a highlight. This one really is
// ~zero and has to stay there: it is the reported "violent shaking", and every
// pixel of it is settleNotesPin writing scrollTop because the repaint displaced
// the reader.
const SHAKE_PX = 40;

let failures = 0;
function ok(name, detail = "") {
  console.log(`ok   ${name}${detail ? `  [${detail}]` : ""}`);
}
function fail(name, detail) {
  failures += 1;
  console.log(`FAIL ${name}${detail ? `  [${detail}]` : ""}`);
}
function check(condition, name, detail) {
  if (condition) ok(name, detail);
  else fail(name, detail);
}

function serveOn(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, "tools/static-server.mjs"), dir, "0"], { stdio: ["ignore", "pipe", "ignore"] });
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

const API_SRC = `async () => {
  const paths = [
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/notes/selection.js?v=__BUILD__",
    "/src/notes/touch-selection.js?v=__BUILD__",
    "/src/format/locate-selection.js?v=__BUILD__",
    "/src/format/highlight.js?v=__BUILD__",
    "/src/format/render-toolbar.js?v=__BUILD__",
    "/src/render/block-cache.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// Big enough to be chunked (NOTES_CHUNK_MIN_BLOCKS is 2,000) and past
// NOTES_INCREMENTAL_SPLIT_MIN_CHARS, but not a whole book: this check is about
// the machinery that switches on at that threshold, and every second spent
// rendering more of it is a second not spent asserting anything.
const SETUP_SRC = `async (apiSrc) => {
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
    from: () => { throw new Error("large-note-selection-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Large note fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  // Paragraphs of DELIBERATELY uneven length. An evenly shaped note hides the
  // whole problem: every chunk is then the height its estimate predicted, so
  // freeing containment moves nothing and the drift case would pass on a build
  // that has never been fixed. Real chapters alternate dense and sparse, which
  // is exactly what makes a chunk's real height differ from the note-wide guess.
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ");
  const lines = ["# Large note", ""];
  for (let i = 0; i < 1400; i += 1) {
    const dense = (i % 7) < 2;
    const body = words.join(" ") + (dense ? " " + words.join(" ").repeat(4) : "");
    lines.push("P" + String(i).padStart(4, "0") + " " + body + ".", "");
    lines.push("- item one for " + i, "- item two for " + i, "");
  }
  api.state.notes = lines.join("\\n");
  api.renderNotesView();
  await settle(1200);

  const view = document.getElementById("notesView");

  // ── The instruments ──────────────────────────────────────────────────────
  //
  // Timed and measured IN THE PAGE, both ends, for the reason
  // tools/touch-selection-check.mjs gives: a harness that timed its own round
  // trip would be measuring the DevTools protocol on a check whose whole subject
  // is milliseconds and pixels.
  window.__press = { startedAt: 0, selectedAt: 0 };
  view.addEventListener("touchstart", () => {
    window.__press.startedAt = performance.now();
    window.__press.selectedAt = 0;
  }, { capture: true, passive: true });
  new MutationObserver(() => {
    if (!window.__press.selectedAt && document.body.classList.contains("is-touch-selecting")) {
      window.__press.selectedAt = performance.now();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  // Total TRAVEL, not net displacement. A note that lurches down 300px and back
  // has a net displacement of zero and is the exact thing "violent shaking"
  // describes, so the sum of absolute steps is the only measurement that sees it.
  window.__travel = { px: 0, last: view.scrollTop, on: false };
  view.addEventListener("scroll", () => {
    const now = view.scrollTop;
    if (window.__travel.on) window.__travel.px += Math.abs(now - window.__travel.last);
    window.__travel.last = now;
  }, { passive: true });
  window.__watchTravel = () => { window.__travel.px = 0; window.__travel.last = view.scrollTop; window.__travel.on = true; };
  window.__stopTravel = () => { window.__travel.on = false; return Math.round(window.__travel.px); };

  // Where a paragraph is ON THE GLASS. The question every drift case asks is
  // whether the words moved under the finger, and scrollTop cannot answer it —
  // that confusion is the bug this file exists for.
  window.__blockTop = (marker) => {
    const p = Array.from(view.querySelectorAll("p")).find((n) => n.textContent.startsWith(marker));
    return p ? p.getBoundingClientRect().top : null;
  };

  window.__firstVisibleMarker = () => {
    const bounds = view.getBoundingClientRect();
    const p = Array.from(view.querySelectorAll("p")).find((n) => {
      const r = n.getBoundingClientRect();
      return r.top >= bounds.top + 80 && r.bottom <= bounds.bottom - 80 && /^P\\d{4} /.test(n.textContent);
    });
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { marker: p.textContent.slice(0, 5), x: r.left + 40, y: r.top + 8, top: r.top };
  };

  window.__frameGap = { worst: 0, last: 0, on: false };
  const beat = () => {
    const now = performance.now();
    if (window.__frameGap.on) window.__frameGap.worst = Math.max(window.__frameGap.worst, now - window.__frameGap.last);
    window.__frameGap.last = now;
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  window.__watchFrames = () => { window.__frameGap.worst = 0; window.__frameGap.last = performance.now(); window.__frameGap.on = true; };
  window.__stopFrames = () => { window.__frameGap.on = false; return Math.round(window.__frameGap.worst); };

  return {
    chars: api.state.notes.length,
    blocks: api.notesTopLevelBlocks(view).filter((n) => n.nodeType === 1).length,
    chunks: view.querySelectorAll(":scope > .notes-chunk").length,
    height: view.scrollHeight
  };
}`;

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("large-note-selection-check: no Chrome on this machine — skipping.");
    return 0;
  }

  const server = await serveOn(ROOT);
  let browser = null;
  const errors = [];
  try {
    browser = await launchChrome(chrome);
    const client = await connect(browser.wsUrl);
    const page = await openPage(client);
    await emulatePhone(page, { width: 390, height: 844, cpuThrottle: THROTTLE });
    await page.call("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*"] });
    client.on((message) => {
      if (message.sessionId !== page.sessionId) return;
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || "unknown");
      }
    });

    const touchStart = (x, y) => page.call("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
    });
    const touchMove = (x, y) => page.call("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
    });
    const touchEnd = () => page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const dragTo = async (fromX, fromY, toX, toY, steps = 10) => {
      for (let i = 1; i <= steps; i += 1) {
        await touchMove(fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps);
        await wait(28);
      }
    };

    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "boot" });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      console.log("large-note-selection-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await wait(1500);

    const gate = await page.evaluate(() => ({
      media: window.matchMedia("(pointer: coarse) and (hover: none)").matches,
      highlights: Boolean(window.CSS && window.CSS.highlights),
      armed: document.body.classList.contains("has-touch-select"),
    }));
    if (!gate.media || !gate.highlights) {
      console.log(`large-note-selection-check: the gate cannot be satisfied under emulation (${JSON.stringify(gate)}).`);
      return 1;
    }

    const setup = await page.evaluate(new Function(`return (${SETUP_SRC})`)(), API_SRC);
    // Every case below is about behaviour that only exists past
    // NOTES_CHUNK_MIN_BLOCKS. If the fixture did not reach it, nothing here
    // would mean anything and passing would be worse than failing.
    if (!setup || setup.chunks < 2) {
      fail("the fixture is chunked", setup ? `${setup.blocks} blocks in ${setup.chunks} chunk(s)` : "missing");
      return 1;
    }
    ok("the fixture is a chunked note", `${Math.round(setup.chars / 1000)}KB, ${setup.blocks} blocks, ${setup.chunks} chunks, ${setup.height}px`);

    // ── 1. A press lands while the note is still settling ───────────────────
    //
    // Scroll into content that has never been laid out and press almost at once,
    // which is what a reader does. The chunks arriving in the estimate
    // observer's runway are measured and pinned right then, so the document's
    // height changes above the viewport and the browser compensates by moving
    // scrollTop — while the words under the finger do not move at all. A press
    // cancelled by that is cancelled for something the reader cannot see.
    {
      await page.evaluate(() => {
        const view = document.getElementById("notesView");
        view.scrollTop = Math.floor(view.scrollHeight * 0.55);
      });
      await wait(140);
      const aim = await page.evaluate(() => window.__firstVisibleMarker());
      if (!aim) {
        fail("a press lands while the note is still settling", "found no paragraph to press on");
      } else {
        await touchStart(aim.x, aim.y);
        await wait(PRESS_MS);
        const result = await page.evaluate((marker) => ({
          selecting: document.body.classList.contains("is-touch-selecting"),
          latency: window.__press.selectedAt ? Math.round(window.__press.selectedAt - window.__press.startedAt) : null,
          moved: (() => { const t = window.__blockTop(marker); return t == null ? null : Math.round(t); })(),
        }), aim.marker);
        await touchEnd();
        check(result.selecting, "a press lands while the note is still settling",
          result.latency != null ? `${result.latency}ms at ${THROTTLE}x CPU throttle` : "no selection appeared");
        // ...and it landed because the page was still, not by luck: the
        // paragraph under the finger is where it was when we aimed.
        check(result.moved != null && Math.abs(result.moved - Math.round(aim.top)) <= DRIFT_PX,
          "...and the paragraph under the finger had not moved",
          `${Math.round(aim.top)}px -> ${result.moved}px`);
      }
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await wait(200);
    }

    // ── 2. A drag across a chunk boundary does not move the text ────────────
    //
    // The drag has to travel far enough to reach a chunk the reader has not
    // seen, because an unmeasured chunk is the whole problem: freeing its
    // containment replaces an estimate with a real height. The assertion is on
    // the paragraph the drag STARTED from — if the document grew above the
    // finger, that paragraph is somewhere else by the end.
    {
      const aim = await page.evaluate(() => window.__firstVisibleMarker());
      if (!aim) {
        fail("a drag across a chunk boundary leaves the text where it was", "found no paragraph to press on");
      } else {
        await touchStart(aim.x, aim.y);
        await wait(PRESS_MS);
        const selecting = await page.evaluate(() => document.body.classList.contains("is-touch-selecting"));
        if (!selecting) {
          fail("a drag across a chunk boundary leaves the text where it was", "the press did not produce a selection");
          await touchEnd();
        } else {
          const before = await page.evaluate((marker) => window.__blockTop(marker), aim.marker);
          // Down to the bottom edge, which is where the controller's own
          // auto-scroll takes over and carries the selection into fresh chunks.
          await dragTo(aim.x, aim.y, aim.x + 120, 800, 12);
          await wait(400);
          const after = await page.evaluate((marker) => ({
            top: window.__blockTop(marker),
            chars: (() => { const s = window.getSelection(); return s && s.rangeCount ? s.getRangeAt(0).toString().length : 0; })(),
          }), aim.marker);
          await touchEnd();
          await wait(200);
          check(after.chars > 20, "the drag extended the selection", `${after.chars} chars`);
          check(before != null && after.top != null && Math.abs(after.top - before) <= DRIFT_PX,
            "a drag across a chunk boundary leaves the text where it was",
            `the paragraph under the finger moved ${before == null || after.top == null ? "?" : Math.round(after.top - before)}px`);
        }
      }
    }

    // ── 3. Highlighting does not shake the note ────────────────────────────
    //
    // The reported symptom, as a number. Total scroll TRAVEL, so a lurch and a
    // correction do not cancel out, measured across the repaint, the pin settle
    // and the autosave that follows them.
    {
      const aim = await page.evaluate(() => window.__firstVisibleMarker());
      if (!aim) {
        fail("highlighting does not shake the note", "found no paragraph to press on");
      } else {
        await touchStart(aim.x, aim.y);
        await wait(PRESS_MS);
        await dragTo(aim.x, aim.y, aim.x + 200, aim.y + 40, 6);
        await touchEnd();
        await wait(500);
        const ready = await page.evaluate(() => ({
          selecting: document.body.classList.contains("is-touch-selecting"),
          chars: (() => { const s = window.getSelection(); return s && s.rangeCount ? s.getRangeAt(0).toString().length : 0; })(),
        }));
        if (!ready.selecting || ready.chars < 3) {
          fail("highlighting does not shake the note", `no selection to highlight (${JSON.stringify(ready)})`);
        } else {
          const outcome = await page.evaluate(async () => {
            const { api, settle } = window.__recall;
            const before = api.state.notes.length;
            // Absent on a build without the incremental splitter. Reported as a
            // failed assertion below rather than thrown, so this file can be run
            // against an older revision to compare.
            const counts = api.notesSplitCounts ? api.notesSplitCounts() : null;
            window.__watchTravel();
            window.__watchFrames();
            api.makeHighlightFromSelection(api.renderTargetConfig("notes"), "yellow");
            await settle(2000);
            const after = counts ? api.notesSplitCounts() : null;
            return {
              marked: api.state.notes.length > before,
              travel: window.__stopTravel(),
              gap: window.__stopFrames(),
              patched: after ? after.incremental - counts.incremental : null,
              full: after ? after.full - counts.full : null,
            };
          });
          check(outcome.marked, "the highlight reached the note");
          check(outcome.travel <= SHAKE_PX, "highlighting does not shake the note",
            `the note travelled ${outcome.travel}px in the 2s after the highlight`);
          check(outcome.patched > 0 && outcome.full === 0,
            "...and the repaint patched the block array rather than re-lexing",
            outcome.patched == null ? "this build has no incremental splitter" : `${outcome.patched} patched, ${outcome.full} full`);
          ok("the worst frame gap while the highlight landed", `${outcome.gap}ms at ${THROTTLE}x CPU throttle`);
        }
      }
    }

    check(errors.length === 0, "no uncaught exceptions", errors.slice(0, 3).join(" | ") || "clean");
  } finally {
    if (browser) browser.close();
    server.proc.kill();
  }
  return failures ? 1 : 0;
}

const code = await run();
console.log(failures ? `\n${failures} failed` : "\nall good");
process.exit(code);
