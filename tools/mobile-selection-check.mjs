// Can you select text with a FINGER?
//
//   node tools/mobile-selection-check.mjs
//   node tools/mobile-selection-check.mjs --throttle=4
//
// Reported as: "I have to almost fight long press for the text selection to
// start, and even if text selection comes the start and end selector indicators
// are almost always wrong. Mis-selection is the primary issue and there is no
// way to easily select from the intended start."
//
// tools/selection-check.mjs answers the same question for a mouse, by dragging
// one. This cannot do the equivalent, and saying so up front is the honest way
// to read every case below:
//
//   A native long press, and the two selection handles it produces, are drawn
//   and driven by the BROWSER, not by the page. Headless Chromium has no touch
//   selection controller, so neither Input.synthesizeTapGesture with a long
//   duration nor a hand-rolled touchStart/hold/touchEnd produces a selection at
//   all — measured, both return zero characters on a bare <p> in a page with no
//   JavaScript in it. There is nothing here for a harness to drive.
//
// So this checks the five things the APP was doing to that gesture, each of
// which is ordinary page behaviour and fully drivable:
//
//   1. touch-action on the reading surfaces. A value naming only pan axes is
//      the compositor fast path that suppresses long-press-to-select and pins a
//      handle to one axis. This is a computed-style assertion, and it is the one
//      that would have caught the original bug.
//   2. The card swipe recogniser standing down for a dwelling finger, instead of
//      preventDefault()ing the press. Real touch events; fully testable.
//   3. content-visibility suspended under a live selection, so the document
//      stops re-laying itself out under the finger.
//   4. The paged-mode page snap not firing while a selection is live.
//   5. The floating pill staying away until the selection settles — which is
//      also what keeps the expensive capture off the thread during a drag.
//
// What is left over — that the handles themselves now land where they are
// aimed — is a real-device check. It is written up in the plan and in README.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const THROTTLE = Number((process.argv.find((a) => a.startsWith("--throttle=")) || "--throttle=1").slice(11)) || 1;

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
    "/src/notes/paged-view.js?v=__BUILD__",
    "/src/notes/selection.js?v=__BUILD__",
    "/src/cards/swipe.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/cards/card-view.js?v=__BUILD__",
    // Last, so nothing it exports can shadow a name one of the modules above
    // owns. Case 3b needs materializeNotesLazySpans: a book is built span by
    // span as it is read, and that case is about containment, not about how the
    // blocks got into the document.
    "/src/render/block-cache.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// Two fixtures, because two of the five questions need different notes.
//
// `probe` is small and uniquely marked, so an assertion can say WHICH paragraph
// was selected — the shape tools/selection-check.mjs already uses.
//
// `book` is over NOTES_CHUNK_MIN_BLOCKS (2,000), which is the only way to reach
// the chunked branch of the containment. A note under that threshold has no
// .notes-chunk elements at all, so case 3 would be asserting nothing.
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
    from: () => { throw new Error("mobile-selection-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Mobile selection fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");
  const para = (i) => "P" + String(i).padStart(4, "0") + " " + words.join(" ") + " " + words.slice(0, 8).join(" ") + ".";

  const probe = ["# Probe note", ""];
  for (let i = 0; i < 60; i += 1) probe.push(para(i), "");

  // 2,400 blocks: comfortably over NOTES_CHUNK_MIN_BLOCKS so reshapeRenderedChunks
  // actually wraps them, without being the multi-megabyte fixture the
  // interaction-scale check uses (this one has to render inside a check run).
  //
  // Deliberately UNEVEN, and that is the whole point of the fixture. The
  // placeholder height is one number for the entire note — measureNotesBlockEstimate
  // takes an average and scales it by NOTES_CHUNK_SIZE — so a note of identical
  // paragraphs has an estimate that happens to be right, nothing shifts when a
  // chunk renders, and the case below passes on a build with the bug still in
  // it (measured: 615px of drift, well inside the tolerance). A real book is
  // figures, tables, code and prose in no particular order; every tenth chunk
  // here is far taller than the average, so the estimate is badly wrong exactly
  // where a drag crosses into unread content.
  const book = ["# Book", ""];
  for (let i = 0; i < 2400; i += 1) {
    book.push(para(i), "");
    if (i % 40 === 20) {
      for (let k = 0; k < 6; k += 1) book.push(para(i) + " " + para(i) + " " + para(i) + " " + para(i), "");
    }
  }

  window.__recall.probe = probe.join("\\n");
  window.__recall.book = book.join("\\n");

  const view = document.getElementById("notesView");
  return { width: view ? view.clientWidth : 0, height: view ? view.clientHeight : 0 };
}`;

// Put one of the fixtures on screen and wait for it to finish rendering.
const LOAD_SRC = `async (which) => {
  const { api, settle } = window.__recall;
  api.state.notes = window.__recall[which];
  api.renderNotesView();
  // Cold renders of the book stream in batches (see block-cache.js); poll for
  // the block count to stop growing rather than guessing at a delay.
  let last = -1;
  for (let i = 0; i < 200; i += 1) {
    await settle(120);
    const now = document.getElementById("notesView").querySelectorAll("p").length;
    if (now === last && now > 0) break;
    last = now;
  }
  const view = document.getElementById("notesView");
  return {
    paragraphs: view.querySelectorAll("p").length,
    chunks: view.querySelectorAll(":scope > .notes-chunk").length
  };
}`;

// Select a whole paragraph by its marker, WITHOUT any pointer input — this is
// the app's own state under a selection, which is what cases 3-5 are about.
const SELECT_PARA_SRC = `(marker) => {
  const view = document.getElementById("notesView");
  const target = Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith(marker));
  if (!target) return null;
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // The app listens on document selectionchange, which a programmatic
  // addRange() does fire — but asynchronously, so the caller settles after this.
  //
  // Measured through the RANGE, not sel.toString(). This file emulates a phone,
  // which is precisely where src/notes/touch-selection.js arms and puts
  // \`user-select: none\` on the reading surfaces — and Chrome answers
  // Selection.toString() with "" over unselectable content while every Range
  // operation on the same selection stays correct. Reading the selection the
  // way the app itself reads it is also the more honest measurement.
  return { len: sel.getRangeAt(0).toString().length, marker };
}`;

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("mobile-selection-check: no Chrome on this machine — skipping.");
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

    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "boot" });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      console.log("mobile-selection-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await new Promise((r) => setTimeout(r, 2000));

    // Everything below is gated on this: the CSS is inside
    // @media (pointer: coarse), so a harness that does not match it would pass
    // every case for the wrong reason.
    const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    if (!coarse) {
      console.log("mobile-selection-check: (pointer: coarse) does not match under emulation — the rules under test are inert, so nothing below would mean anything.");
      return 1;
    }

    const setup = await page.evaluate(new Function(`return (${SETUP_SRC})`)(), API_SRC);
    if (!setup || setup.width < 200 || setup.height < 200) {
      console.log(`mobile-selection-check: #notesView is ${setup ? `${setup.width}x${setup.height}` : "missing"} — nothing below would mean anything`);
      return 1;
    }

    const probe = await page.evaluate(new Function(`return (${LOAD_SRC})`)(), "probe");
    check(probe.paragraphs >= 60, "the probe note rendered", `${probe.paragraphs} paragraphs`);

    // ── 1. touch-action ─────────────────────────────────────────────────────
    //
    // The direct assertion for the primary cause. `pan-y` on .notes-rendered
    // and `pan-x` on the paged surface are what put the gesture on the
    // compositor fast path, where a long press is not offered to the text and a
    // handle is pinned to one axis.
    const touchActions = await page.evaluate(() => {
      const at = (sel) => {
        const node = document.querySelector(sel);
        return node ? getComputedStyle(node).touchAction : "(missing)";
      };
      return {
        notes: at("#notesView"),
        card: at(".card"),
        cardFace: at(".card-face"),
        pre: at(".rendered pre"),
        table: at(".markdown-table-wrap")
      };
    });
    check(touchActions.notes === "auto",
      "the notes surface leaves touch to the browser", `touch-action: ${touchActions.notes}`);
    check(touchActions.card === "auto" || touchActions.card === "(missing)",
      "the card leaves touch to the browser", `touch-action: ${touchActions.card}`);
    check(touchActions.cardFace === "auto" || touchActions.cardFace === "(missing)",
      "the card face leaves touch to the browser", `touch-action: ${touchActions.cardFace}`);

    // Paged mode is the phone reading mode, and it was the worst of them:
    // `pan-x` means a handle cannot travel vertically at all.
    await page.evaluate(async () => {
      window.__recall.api.setNotesReadingMode("paged-1");
      await window.__recall.settle(1200);
    });
    const pagedTouchAction = await page.evaluate(() => {
      const view = document.getElementById("notesView");
      return { paged: view.classList.contains("is-paged"), value: getComputedStyle(view).touchAction };
    });
    check(pagedTouchAction.paged && pagedTouchAction.value === "auto",
      "paged reading leaves touch to the browser",
      `is-paged: ${pagedTouchAction.paged}, touch-action: ${pagedTouchAction.value}`);

    // ── 4. The paged snap must not fire under a live selection ──────────────
    //
    // Extending a selection to the edge of a page auto-scrolls the view, which
    // arrives at scheduleNotesPageSettle as an ordinary scroll — and 140ms
    // later it smooth-scrolled the columns back to the nearest boundary, out
    // from under the finger holding the handle.
    const pagedSnap = await page.evaluate(async (selectSrc) => {
      const { api, settle } = window.__recall;
      const view = document.getElementById("notesView");
      const selectPara = (0, eval)(`(${selectSrc})`);
      selectPara("P0004");
      await settle(120);
      // Park the flow deliberately off a page boundary, the way an auto-scroll
      // part-way through a drag would.
      const offBoundary = Math.round(view.clientWidth * 0.45);
      view.scrollLeft = offBoundary;
      view.dispatchEvent(new Event("scroll"));
      await settle(700);
      const whileLive = view.scrollLeft;
      // Now let go: collapsing is what re-arms the settle.
      window.getSelection().removeAllRanges();
      await settle(1200);
      return { offBoundary, whileLive, afterCollapse: view.scrollLeft, width: view.clientWidth };
    }, SELECT_PARA_SRC);
    check(Math.abs(pagedSnap.whileLive - pagedSnap.offBoundary) < 2,
      "a live selection is not snapped to the nearest page",
      `left ${pagedSnap.offBoundary} -> ${pagedSnap.whileLive}`);
    check(Math.abs(pagedSnap.afterCollapse % pagedSnap.width) < 2
      || Math.abs((pagedSnap.afterCollapse % pagedSnap.width) - pagedSnap.width) < 2,
      "the page still settles once the selection is let go",
      `left ${pagedSnap.whileLive} -> ${pagedSnap.afterCollapse} (page ${pagedSnap.width})`);

    await page.evaluate(async () => {
      window.__recall.api.setNotesReadingMode("continuous");
      await window.__recall.settle(1000);
    });

    // ── 5. The pill waits for the selection to settle ───────────────────────
    //
    // A native handle drag sends no pointer events, so the existing gesture
    // guard cannot see it: every quiet moment during the drag ran the full
    // describe-the-selection pass (~218ms on a big note) and put the bar on
    // screen over the words being chosen. The bar must be absent while the
    // selection is still moving, and present once it stops — the second half
    // matters as much as the first, or the "fix" is just a broken bar.
    const pill = await page.evaluate(async (selectSrc) => {
      const { settle } = window.__recall;
      const selectPara = (0, eval)(`(${selectSrc})`);
      const float = document.getElementById("selectionFloat");
      selectPara("P0007");
      // A burst, the way a handle drag arrives — and deliberately SLOWER than
      // the 160ms debounce this replaced. At 60ms a gap never opened, so the
      // old build passed this case for the wrong reason; at 200ms the old
      // debounce fires mid-burst and puts the bar on screen over the words
      // still being chosen, which is exactly the reported behaviour.
      let hiddenDuring = true;
      for (let i = 0; i < 6; i += 1) {
        selectPara(i % 2 ? "P0007" : "P0008");
        await settle(200);
        if (!float.hidden) hiddenDuring = false;
      }
      await settle(900);
      const btn = document.getElementById("makeCardFromSelectionBtn");
      return {
        hiddenDuring,
        shownAfter: !float.hidden,
        captured: (btn?.dataset.selectionText || "").length
      };
    }, SELECT_PARA_SRC);
    check(pill.hiddenDuring, "the bar stays away while the selection is still moving");
    check(pill.shownAfter, "the bar arrives once the selection settles");
    check(pill.captured > 0,
      "the settled selection is still captured for the bar's buttons",
      `${pill.captured} chars of markdown`);

    // ── 3a. content-visibility on an ORDINARY note ─────────────────────────
    //
    // Chunking only starts at NOTES_CHUNK_MIN_BLOCKS (2,000), so almost every
    // real note takes this branch, not the one below it: containment is
    // per-block (styles/12-notes.css:255) and there are no chunks to mark. The
    // whole view is freed instead, which is affordable for exactly the reason
    // it has no chunks. Checked on the probe note, which is still loaded.
    //
    // setTouchSelectionDragging(true) around both containment cases, because
    // "is a selection being adjusted right now" stopped being an INFERENCE the
    // moment src/notes/touch-selection.js started drawing the handles: on a
    // touchscreen it is reported, and a bare programmatic selection is not a
    // gesture and correctly reads as finished. Setting the same flag a real
    // drag sets is how these two cases keep asking what they were written to
    // ask — how the region is marked and how tightly it is scoped — rather than
    // quietly becoming a test of the flag. The real gesture end to end is
    // tools/touch-selection-check.mjs.
    const unchunked = await page.evaluate(async (selectSrc) => {
      const { api, settle } = window.__recall;
      const selectPara = (0, eval)(`(${selectSrc})`);
      const view = document.getElementById("notesView");
      api.setTouchSelectionDragging(true);
      selectPara("P0030");
      await settle(200);
      const block = Array.from(view.children).find((n) => n.textContent.startsWith("P0030"));
      // Containment is freed per BLOCK now, around the selection, rather than
      // across the whole view — the view-wide version moved the page at the
      // start of every gesture, because every never-painted block took its real
      // height at once, the ones above the reader included.
      const far = Array.from(view.children).find((n) => n.textContent.startsWith("P0002"));
      return {
        marked: Boolean(block && block.classList.contains("is-selection-stable")),
        chunks: view.querySelectorAll(":scope > .notes-chunk").length,
        computed: block ? getComputedStyle(block).contentVisibility : "(no block)",
        far: far ? getComputedStyle(far).contentVisibility : "(no block)"
      };
    }, SELECT_PARA_SRC).finally(() => page.evaluate(() => window.__recall.api.setTouchSelectionDragging(false)));
    check(unchunked.chunks === 0, "the probe note is not chunked", `${unchunked.chunks} chunks`);
    check(unchunked.marked, "an unchunked note frees containment on the block under the selection");
    check(unchunked.computed === "visible",
      "and that block really is laid out under the selection",
      `content-visibility: ${unchunked.computed}`);
    check(unchunked.far !== "visible",
      "...and a block far from the selection is left contained",
      `content-visibility: ${unchunked.far}`);

    // ── 3b. content-visibility, on a note big enough to have chunks ─────────
    const book = await page.evaluate(new Function(`return (${LOAD_SRC})`)(), "book");
    check(book.chunks > 1, "the book fixture is chunked", `${book.paragraphs} paragraphs in ${book.chunks} chunks`);

    if (book.chunks > 1) {
      const containment = await page.evaluate(async (selectSrc) => {
        const { api, settle } = window.__recall;
        const selectPara = (0, eval)(`(${selectSrc})`);
        const view = document.getElementById("notesView");
        // ── The whole book, on purpose ──────────────────────────────────────
        //
        // A note this size is built span by span as the reader reaches each one,
        // so paragraph 400 is not in the document until somebody goes there.
        // What this case is about is what happens to CONTAINMENT under a live
        // selection, which has nothing to do with how the blocks got there — so
        // it puts them all there and asks its own question. (render-scale and
        // interaction are where the deferral itself is asserted.)
        if (api.materializeNotesLazySpans) await api.materializeNotesLazySpans(view);
        await settle(200);
        const before = view.scrollHeight;
        // See the note on case 3a for why the drag flag is set here.
        api.setTouchSelectionDragging(true);
        selectPara("P0400");
        await settle(200);
        const chunks = Array.from(view.querySelectorAll(":scope > .notes-chunk"));
        const stable = chunks.filter((c) => c.classList.contains("is-selection-stable"));
        const computed = stable.map((c) => getComputedStyle(c).contentVisibility);
        const body = document.body.classList.contains("is-selecting");
        return {
          body,
          stableCount: stable.length,
          totalChunks: chunks.length,
          computed: Array.from(new Set(computed)),
          before
        };
      }, SELECT_PARA_SRC);

      check(containment.body, "a live touch selection marks the document");
      check(containment.stableCount > 0 && containment.stableCount < containment.totalChunks,
        "containment is suspended over the selection, and only there",
        `${containment.stableCount} of ${containment.totalChunks} chunks`);
      check(containment.computed.length === 1 && containment.computed[0] === "visible",
        "the suspended chunks really are laid out",
        `content-visibility: ${containment.computed.join(", ") || "(none)"}`);
      // The SHIFT itself is deliberately not asserted here, and the reason is
      // worth stating rather than quietly leaving a weak case in place.
      //
      // What moves the document is a placeholder being replaced by real layout
      // as content comes near the viewport, and the thing that brings it near
      // is the browser auto-scrolling under a dragged handle. Two attempts to
      // stand in for that failed to distinguish a fixed build from a broken
      // one: extending the selection programmatically never renders the
      // neighbouring chunks at all (measured 615px of drift on the BROKEN
      // build, well inside any tolerance), and driving view.scrollTop and
      // waiting produced 0px on both, because the settle is over before the
      // measurement. A check that passes either way is worse than no check.
      //
      // So the three assertions above are the honest ones: they prove the
      // region under the selection is marked, is scoped to it, and really is
      // laid out. That the reader stops feeling the text move is the
      // real-device observation in README.
      await page.evaluate(() => window.__recall.api.setTouchSelectionDragging(false));
    }

    // ── 2. The card swipe stands down for a dwelling finger ─────────────────
    //
    // This is the "fight the long press" half, and unlike the handles it IS
    // drivable: the swipe is the app's own code, reading its own touch events.
    //
    // The bug: `state.dragMoved` latches at 6px and is sticky, so a finger that
    // wobbled while dwelling could never reach the long-press escape — and the
    // slow drag that followed was treated as a swipe and preventDefault()ed,
    // which cancels a pending native selection.
    //
    // ── What src/notes/touch-selection.js changed about this case ───────────
    //
    // "The drag after a dwell is never cancelled" was the right assertion while
    // the SELECTION belonged to the browser: a cancelled touchmove was the app
    // stepping on a gesture it did not own. It is the wrong assertion now. On a
    // touchscreen the app owns the press, and a drag after one is the reader
    // extending a selection the app has already made — cancelling it is how the
    // page is stopped from scrolling out from under them.
    //
    // So the question is no longer "was anything cancelled" but WHO cancelled
    // it, and both answers are asserted below:
    //
    //   • the SWIPE still stands down — state.dragPointerId is null, so nothing
    //     in swipe.js can preventDefault another move in this gesture. That is
    //     the original bug, and it is still the thing that must not come back.
    //   • a cancelled move is therefore the touch controller's, and it is only
    //     acceptable if it bought a selection. Where the controller is not armed
    //     (no Custom Highlight API, or a machine whose primary pointer is a
    //     cursor) nothing may cancel anything at all — the native gesture is
    //     back in charge and this file's original assertion applies unchanged.
    await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      // A card to press on. The fixture deck is notes-only, and the swipe
      // recogniser is bound to #card — with no card there is nothing to dwell
      // on and the two cases below would skip rather than assert.
      const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
      api.state.masterCards = [
        { question: "Question one", answer: `Answer one. ${words} ${words} ${words}` },
        { question: "Question two", answer: `Answer two. ${words} ${words} ${words}` }
      ];
      api.state.cards = api.state.masterCards.slice();
      api.state.current = 0;
      api.setViewMode("cards");
      await settle(400);
      await api.showCard();
      await settle(600);
    });
    const cardBox = await page.evaluate(() => {
      const card = document.getElementById("card");
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ok: r.width > 40 && r.height > 40 };
    });

    if (!cardBox?.ok) {
      console.log("note: no card on screen — the swipe cases need a deck with a card in it, skipping them");
    } else {
      const touch = (type, x, y) => page.call("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }]
      });
      // Watch for the thing that actually breaks selection: a cancelled
      // touchmove. Nothing else about the swipe matters to a reader trying to
      // press and hold.
      await page.evaluate(() => {
        window.__prevented = 0;
        window.__moveListener = (e) => { if (e.defaultPrevented) window.__prevented += 1; };
        document.getElementById("card").addEventListener("touchmove", window.__moveListener);
      });

      // Press, wobble ±8px (inside the 16px dwell slop, outside the old 6px
      // latch), dwell past longPressGraceMs, then drag slowly the way a finger
      // extending a fresh selection does.
      await touch("touchStart", cardBox.x, cardBox.y);
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 70));
        await touch("touchMove", cardBox.x + (i % 2 ? 8 : -8), cardBox.y + (i % 2 ? -6 : 6));
      }
      await new Promise((r) => setTimeout(r, 300));
      const afterDwell = await page.evaluate(() => ({
        pointerId: window.__recall.api.state.dragPointerId,
        dragging: window.__recall.api.state.dragging
      }));
      for (let i = 1; i <= 10; i += 1) {
        await new Promise((r) => setTimeout(r, 40));
        await touch("touchMove", cardBox.x + i * 14, cardBox.y);
      }
      await touch("touchEnd", cardBox.x, cardBox.y);
      await new Promise((r) => setTimeout(r, 200));
      const swipe = await page.evaluate(() => {
        const sel = window.getSelection();
        const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
        return {
          prevented: window.__prevented,
          transform: document.getElementById("card").style.transform,
          armed: document.body.classList.contains("has-touch-select"),
          // Through the range: over the `user-select: none` the controller puts
          // on a card face, Selection.toString() is "" while every Range
          // operation on the same selection stays correct.
          selected: range ? range.toString().trim().length : 0
        };
      });

      check(afterDwell.pointerId === null && !afterDwell.dragging,
        "a dwelling finger stands the card swipe down",
        `dragPointerId: ${String(afterDwell.pointerId)}, dragging: ${afterDwell.dragging}`);
      if (swipe.armed) {
        check(swipe.selected > 0,
          "a dwell on a card face produces a selection, and the drag extends it",
          `${swipe.selected} chars, ${swipe.prevented} touchmove(s) cancelled by the controller`);
      } else {
        check(swipe.prevented === 0,
          "the drag after a dwell is never cancelled out from under the browser",
          `${swipe.prevented} cancelled touchmove(s)`);
      }
      check(!swipe.transform,
        "and the card did not swipe", `transform: ${swipe.transform || "(none)"}`);
    }

    check(errors.length === 0, "the page threw nothing", errors.slice(0, 2).join(" | "));
  } finally {
    server.proc.kill();
    browser?.proc?.kill?.();
  }

  console.log("");
  console.log("Not covered here, and it cannot be: the NATIVE long press itself and the");
  console.log("two handles it produces are browser UI, absent in headless Chromium — a");
  console.log("synthesized long press selects nothing even on a bare <p>.");
  console.log("");
  console.log("That hole is why this file exists in the shape it does, and it is no longer");
  console.log("the whole story: tools/touch-selection-check.mjs drives the app's OWN press");
  console.log("and its own handles end to end, because handles the app draws are ordinary");
  console.log("DOM elements. What is left un-driven here is the fallback path — a browser");
  console.log("without the Custom Highlight API, where the native gesture is still in");
  console.log("charge and everything above is what keeps the app out of its way.");
  return failures ? 1 : 0;
}

process.exit(await run());
