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
// ── The fixture used to stop one threshold short, and it mattered ─────────
//
// It was ~284KB of paragraph-then-list, paragraph-then-list. Past
// NOTES_LAZY_MIN_CHARS by a comfortable margin — and it never once took the
// viewport-built path, because findSafeLexerBoundaries cannot cut before a list
// marker OR after one, so a note shaped like that has exactly one safe cut and
// renderNotesLazily bails to the eager path. Every case here has been asserting
// chunked behaviour on a note that a real reader's book does not resemble, and
// the gesture bugs that prompted this were all happening on the path it was
// skipping. Lists on every fifth paragraph and enough of them to clear
// NOTES_LAZY_MIN_SPANS fixes it; the setup now reports whether the note went
// lazy, and the cases that need it fail rather than pass quietly.
//
// So: ~549KB and 65 SPANS, past every threshold that changes behaviour
// (NOTES_CHUNK_MIN_BLOCKS, NOTES_PARSE_CHUNK_MIN_CHARS,
// NOTES_INCREMENTAL_SPLIT_MIN_CHARS, NOTES_LAZY_MIN_CHARS,
// NOTES_LAZY_MIN_SPANS) and still quick to open — being built as it is read is
// what makes it quick. The COST of those paths at book scale —
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
  // ── ...and CUTTABLE, which the first version of this fixture was not ─────
  //
  // Every paragraph used to be followed by a two-item list. findSafeLexerBoundaries
  // will not cut before a list marker (a list can continue across a blank line)
  // and will not cut after one either — the line before the blank run has to be
  // a safe block start, and a list item is not one. So a note built entirely of
  // paragraph-list-paragraph-list produced exactly ONE span, renderNotesLazily
  // bailed to the eager path, and this file has never once driven the code that
  // builds a note as it is read. Which is the code the reported gesture bugs
  // were happening on top of.
  //
  // Two changes, and no more: lists on every fifth group rather than every one,
  // so paragraph follows paragraph often enough to give real cut points, and
  // enough groups to clear NOTES_LAZY_MIN_SPANS with room to spare. The uneven
  // dense/sparse alternation below is untouched — it is what makes a chunk's
  // real height differ from the note-wide guess, and every drift case here
  // depends on it.
  //
  // The setup return reports whether the note actually went lazy, and the case
  // that needs it fails loudly rather than passing quietly if it ever stops.
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ");
  const lines = ["# Large note", ""];
  for (let i = 0; i < 3200; i += 1) {
    const dense = (i % 7) < 2;
    const body = words.join(" ") + (dense ? " " + words.join(" ").repeat(4) : "");
    lines.push("P" + String(i).padStart(4, "0") + " " + body + ".", "");
    if (i % 5 === 0) lines.push("- item one for " + i, "- item two for " + i, "");
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

  // ── Spans arriving ───────────────────────────────────────────────────────
  //
  // Past NOTES_LAZY_MIN_CHARS a note is not lexed at all until the reader comes
  // near each part of it, and this fixture is well past it — so the chunks here
  // are SPANS, and an unread one is an empty div wearing NOTES_CHUNK_PENDING_CLASS
  // and a min-height. Promotion is a lex plus a render plus a replaceChildren,
  // run synchronously off an IntersectionObserver entry.
  //
  // Counted by watching the class come off rather than by wrapping the builder:
  // buildNotesLazySpan is called from inside its own module, so an export the
  // harness monkey-patched would never be the one the observer reaches.
  //
  // Also watched: whether a chunk still wearing that class was ever given an
  // inline contain-intrinsic-size. Measuring an empty placeholder pins the GUESS
  // permanently — measureNotesChunkEstimate marks its WeakSet before it measures
  // — so the crossing that pinning exists to smooth becomes the one that lurches.
  window.__spans = { built: 0, pinnedPending: 0, on: false };
  new MutationObserver((records) => {
    records.forEach((record) => {
      const el = record.target;
      if (!el.classList || !el.classList.contains("notes-chunk")) return;
      if (record.attributeName === "class") {
        const was = String(record.oldValue || "");
        if (was.includes("is-pending") && !el.classList.contains("is-pending")) {
          window.__spans.built += 1;
        }
        return;
      }
      if (el.classList.contains("is-pending") && el.style.containIntrinsicSize) {
        window.__spans.pinnedPending += 1;
      }
    });
  }).observe(view, {
    attributes: true, subtree: true, attributeOldValue: true,
    attributeFilter: ["class", "style"],
  });
  window.__watchSpans = () => { window.__spans.built = 0; window.__spans.pinnedPending = 0; };

  // Why a note this size did NOT take the viewport-built path — computed only
  // when the assertion that needs it fails, because a boundary scan and a span
  // plan over half a megabyte is not free and every run would pay for it.
  window.__lazyWhy = () => {
    try {
      const src = api.state.notes;
      return {
        gate: api.canRenderNotesLazily(view, src),
        spans: api.planNotesLazySpans(src, api.findSafeLexerBoundaries(src)).length,
        minSpans: api.NOTES_LAZY_MIN_SPANS,
      };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  };

  // Park the reader just short of an unbuilt span, so a drag of a few hundred
  // pixels is certain to reach it.
  //
  // Without this the case has to out-travel whatever gap happens to lie ahead:
  // the spans on this fixture sit ~5,600px apart and DEFERRED_WORK_MARGIN is
  // 1,200px, so a drag starting just after one boundary needs ~4,400px before
  // the next enters the runway — and one starting just before needs almost
  // none. Measured, the same held drag covered 1,875px on one run and 1,260px
  // on the next, which is the difference between an assertion and a coin toss.
  //
  // The margin is deliberately OUTSIDE the runway, so parking does not itself
  // build the span the drag is supposed to reach.
  window.__parkBeforePendingSpan = (margin) => {
    const chunks = Array.from(view.querySelectorAll(":scope > .notes-chunk.is-pending"));
    const bounds = view.getBoundingClientRect();
    const next = chunks.find((c) => c.getBoundingClientRect().top > bounds.bottom);
    if (!next) return null;
    view.scrollTop += (next.getBoundingClientRect().top - bounds.bottom) - margin;
    return Math.round(next.getBoundingClientRect().top - bounds.bottom);
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
    pending: view.querySelectorAll(":scope > .notes-chunk.is-pending").length,
    // Is this note on the VIEWPORT-BUILT path at all, or merely chunked? The two
    // produce a very similar chunk count on a fixture this size — 2,801 blocks
    // is 71 chunks of 40, and it is also about 71 spans — so counting chunks
    // cannot tell them apart, and the case below is only meaningful on one of
    // them.
    lazy: Boolean(api.notesLazyPlans && api.notesLazyPlans.get(view)),
    lazyMin: api.NOTES_LAZY_MIN_CHARS,
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
    //
    // Now that the fixture is genuinely built as it is read, this lands on the
    // second half of the same problem: the blocks coming on screen swap their
    // estimated heights for real ones and the words under the finger DO move,
    // once, by about 16px, inside the first 100ms — after which the page is
    // perfectly still for the rest of the window. Cancelling a press for that
    // is the same mistake measured from the other side, and PRESS_SETTLE_MAX_PX
    // in src/notes/touch-selection.js is the answer to it. The trace below is
    // what tells the two apart when this fails.
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
        // The press window itself, sampled from inside the page rather than
        // waited out blind. "The paragraph ended up 37px away" cannot say
        // whether it moved before the finger landed (harmless — the drift
        // reference is taken at touchdown) or during the press (fatal — that is
        // what cancels it), still less whether it moved all at once or kept
        // moving. Those are different bugs with different fixes, and this is
        // the difference between reading the answer off a failure and guessing
        // at it. Eight rect reads across 840ms is nothing next to the layout
        // the browser is doing on every one of those frames anyway.
        const trace = await page.evaluate(async (marker, ms) => {
          const at = [];
          const t0 = performance.now();
          for (let i = 0; i < 8; i += 1) {
            at.push({
              ms: Math.round(performance.now() - t0),
              top: (() => { const t = window.__blockTop(marker); return t == null ? null : Math.round(t); })(),
              scrollTop: Math.round(document.getElementById("notesView").scrollTop),
            });
            await new Promise((r) => setTimeout(r, ms / 8));
          }
          return at;
        }, aim.marker, PRESS_MS);
        const result = await page.evaluate((marker) => ({
          selecting: document.body.classList.contains("is-touch-selecting"),
          latency: window.__press.selectedAt ? Math.round(window.__press.selectedAt - window.__press.startedAt) : null,
          moved: (() => { const t = window.__blockTop(marker); return t == null ? null : Math.round(t); })(),
        }), aim.marker);
        await touchEnd();
        check(result.selecting, "a press lands while the note is still settling",
          result.latency != null ? `${result.latency}ms at ${THROTTLE}x CPU throttle`
            : "no selection appeared — the paragraph under the finger went "
              + trace.map((s) => `${s.ms}ms:${s.top}`).join(" "));
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

    // ── 2b. No span is built underneath a finger ───────────────────────────
    //
    // This fixture is past NOTES_LAZY_MIN_CHARS, so it is not merely chunked —
    // it is built as it is read, and most of it is still an empty placeholder.
    // Promotion is a synchronous lex plus render plus replaceChildren fired
    // straight off an IntersectionObserver entry, and a selection drag reaches
    // fresh spans constantly: the edge auto-scroll moves the viewport at up to
    // 960px/s, which is the case above.
    //
    // Landing that work on the frames the reader is dragging in costs twice.
    // The document's height changes, because a placeholder standing at an
    // estimate takes its real height — that is what case 2 measures. And the
    // renderer stops answering, which is worse and invisible from the DOM:
    // Chrome only lets a page cancel a touch scroll for as long as the main
    // thread acks the touch in time, so a long enough task hands the scroll to
    // the compositor mid-gesture and the selection is dragged across a page it
    // can no longer hold still.
    //
    // So the promotion waits for the finger to lift. Both halves are asserted,
    // because deferring work that is then never done would look identical here
    // and be a far worse bug: a reader would be left holding a blank screenful
    // of a book.
    if (!setup.lazy || !setup.pending) {
      const why = await page.evaluate(() => window.__lazyWhy());
      fail("the fixture is built as it is read",
        `lazy plan: ${setup.lazy}, ${setup.pending} of ${setup.chunks} chunk(s) pending, `
        + `${Math.round(setup.chars / 1000)}KB against a ${Math.round((setup.lazyMin || 0) / 1000)}KB threshold, `
        + JSON.stringify(why));
    } else {
      ok("the fixture is built as it is read",
        `${setup.pending} of ${setup.chunks} spans still placeholders`);
      // 1400px: outside DEFERRED_WORK_MARGIN's 1200px runway, so parking here
      // does not build the span the drag has to reach, and close enough that a
      // second of edge auto-scroll certainly does.
      const parked = await page.evaluate(() => window.__parkBeforePendingSpan(1400));
      await wait(300);
      const aim = await page.evaluate(() => window.__firstVisibleMarker());
      if (parked == null) {
        fail("no span is built while a finger is on the surface", "no unbuilt span left below the reader");
      } else if (!aim) {
        fail("no span is built while a finger is on the surface", "found no paragraph to press on");
      } else {
        const startedAt = await page.evaluate(() => {
          window.__watchSpans();
          return document.getElementById("notesView").scrollTop;
        });
        await touchStart(aim.x, aim.y);
        await wait(PRESS_MS);
        const selecting = await page.evaluate(() => document.body.classList.contains("is-touch-selecting"));
        if (!selecting) {
          fail("no span is built while a finger is on the surface", "the press did not produce a selection");
          await touchEnd();
        } else {
          // Into the bottom edge and HELD there, so the auto-scroll runs the
          // viewport through span after span — which is what makes "zero" an
          // assertion rather than an accident of a drag too short to reach one.
          //
          // Right at the edge, not merely inside the band: the speed ramps
          // linearly from nothing at EDGE_PX out to EDGE_MAX_SPEED_PX at the
          // rim, so a finger parked halfway in travels at half speed. With the
          // next unbuilt span parked 200px outside the runway above, a second
          // of this covers it several times over.
          const rim = await page.evaluate(
            () => Math.round(document.getElementById("notesView").getBoundingClientRect().bottom) - 6
          );
          await dragTo(aim.x, aim.y, aim.x + 120, rim, 12);
          await wait(1500);
          const during = Object.assign(await page.evaluate(() => ({
            built: window.__spans.built,
            pinnedPending: window.__spans.pinnedPending,
            scrollTop: document.getElementById("notesView").scrollTop,
          })), { startedAt });
          await touchEnd();
          // The release drains the queue synchronously, but the spans it builds
          // finish asynchronously — give them the same settle every other case
          // in this file gives a render.
          await wait(600);
          const after = await page.evaluate(() => window.__spans.built);
          check(during.built === 0,
            "no span is built while a finger is on the surface",
            `${during.built} span(s) promoted during the drag`);
          check(after > during.built,
            "...and every span the drag queued is built the moment it lifts",
            `${after - during.built} span(s) promoted after the finger left, `
            + `note travelled ${Math.round(during.scrollTop - during.startedAt)}px under the drag`);
          check(during.pinnedPending === 0,
            "...and no placeholder was height-pinned to its own guess",
            `${during.pinnedPending} pending chunk(s) given a contain-intrinsic-size`);
        }
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await wait(200);
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
            // ...and the same question one level up, for the path a note THIS
            // size actually takes. Now that the fixture is cuttable it is built
            // as it is read, and an edit to it is patched into one SPAN by
            // patchNotesLazyPlanLocally rather than into the block array by the
            // incremental splitter — so the splitter's counters correctly stay
            // at zero and the claim "it did not re-lex the book" has to be read
            // off notesLazyPatchCounts instead. Both are collected; the
            // assertion below accepts whichever path this note took, and fails
            // if NEITHER moved, which is the thing worth catching.
            const lazyCounts = api.notesLazyPatchCounts ? api.notesLazyPatchCounts() : null;
            window.__watchTravel();
            window.__watchFrames();
            api.makeHighlightFromSelection(api.renderTargetConfig("notes"), "yellow");
            await settle(2000);
            const after = counts ? api.notesSplitCounts() : null;
            const lazyAfter = lazyCounts ? api.notesLazyPatchCounts() : null;
            return {
              marked: api.state.notes.length > before,
              travel: window.__stopTravel(),
              gap: window.__stopFrames(),
              patched: after ? after.incremental - counts.incremental : null,
              full: after ? after.full - counts.full : null,
              lazyLocal: lazyAfter ? lazyAfter.local - lazyCounts.local : null,
              lazyReplanned: lazyAfter ? lazyAfter.replanned - lazyCounts.replanned : null,
            };
          });
          check(outcome.marked, "the highlight reached the note");
          check(outcome.travel <= SHAKE_PX, "highlighting does not shake the note",
            `the note travelled ${outcome.travel}px in the 2s after the highlight`);
          const patchedLocally = (outcome.patched > 0 && outcome.full === 0)
            || (outcome.lazyLocal > 0 && outcome.lazyReplanned === 0);
          check(patchedLocally,
            "...and the repaint patched one span rather than re-lexing the note",
            outcome.patched == null ? "this build has no incremental splitter"
              : `blocks: ${outcome.patched} patched / ${outcome.full} full · `
                + `spans: ${outcome.lazyLocal} patched / ${outcome.lazyReplanned} re-planned`);
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
