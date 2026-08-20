// Can you select text with a finger, when the APP owns the gesture?
//
//   node tools/touch-selection-check.mjs
//   node tools/touch-selection-check.mjs --throttle=4
//
// tools/mobile-selection-check.mjs answers a narrower question — is the app
// still getting in the way of the NATIVE gesture — and has to open by admitting
// what it cannot do: headless Chromium has no touch-selection controller, so a
// synthesised long press produces no selection at all and the native handles do
// not exist to be dragged. Half of that file's subject was a by-hand check on a
// real phone.
//
// That limitation is gone here, and it is the strongest argument for the
// takeover after the behaviour itself: a selection the app implements is one a
// harness can drive. Every case below is real touch input through
// Input.dispatchTouchEvent, against real handles that are real DOM elements,
// asserting the real range.
//
// The five cases that answer the report directly:
//
//   1. A press becomes a selection in a bounded, measured time — the "3-4s gap
//      after I hard press" complaint, as a number, including at a 4x CPU
//      throttle where the native path is at its worst.
//   2. The handles sit ON the boundaries they mark — the screenshot, as a pixel
//      distance, before and after a drag.
//   3. A press at the very start of a block anchors in that block — "more error
//      when I am starting selection from the very start of a corner".
//   4. Dragging a handle extends the selection, including back across its own
//      anchor.
//   5. None of it exists on a desktop.

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
    "/src/notes/selection.js?v=__BUILD__",
    "/src/notes/touch-selection.js?v=__BUILD__",
    "/src/format/locate-selection.js?v=__BUILD__",
    "/src/format/highlight.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// A note of uniquely marked paragraphs, so every assertion can say WHICH
// paragraph and WHICH word it landed on — the shape tools/selection-check.mjs
// established. Deliberately small: nothing here is about render scale, and a
// book-sized fixture would make the timing case measure the renderer instead of
// the press.
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
    from: () => { throw new Error("touch-selection-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Touch selection fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ");
  const lines = ["# Probe note", ""];
  // L0000 first, and long on purpose. Every other paragraph here wraps to two
  // lines, which has a FIRST line and a LAST line and no line in between — so
  // nothing in this file could ever aim at an interior line boundary, which is
  // where the caret sweeps below have to aim. Six lines gives them four.
  lines.push("L0000 " + [words, words, words, words, words].map((w) => w.join(" ")).join(" ") + ".", "");
  for (let i = 0; i < 80; i += 1) lines.push("P" + String(i).padStart(4, "0") + " " + words.join(" ") + ".", "");
  api.state.notes = lines.join("\\n");
  api.renderNotesView();
  await settle(600);

  // ── The page-side instruments ────────────────────────────────────────────
  //
  // Timing is stamped IN THE PAGE, both ends. A harness that timed the round
  // trip from its own dispatch to its own poll would be measuring the DevTools
  // protocol, on a check whose entire subject is a number of milliseconds.
  const view = document.getElementById("notesView");
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

  // ── Counting the work, not just the outcome ──────────────────────────────
  //
  // Two of the three complaints in the report are about how the app FEELS
  // rather than about what it ends up with, and a case that only asserts the
  // final range cannot tell a smooth drag from a stuttering one. These two
  // instruments count the work instead.
  //
  // __hits counts caret hit-tests. caretInRoot() runs one per extendTo() in the
  // ordinary case (the direct hit is usable), so it is a count of extend passes
  // — and the whole point of the frame coalescing is that a burst of touchmoves
  // inside one frame produces ONE of them.
  //
  // It doubles as a FAULT INJECTOR. caretPositionFromPoint does not fail on
  // demand — it fails at an inline boundary, at a sub-pixel position, beside a
  // <br>, at an element edge — so the repair ladder underneath it was never
  // driven by anything here, and a confidently wrong answer from that ladder
  // shipped. A failEvery counter makes it deterministic: every Nth call answers with the
  // CONTAINING ELEMENT, which is exactly the shape the platform fails with, and
  // which usableCaret() correctly rejects.
  window.__hits = { count: 0, failEvery: 0 };
  const nativeCaret = document.caretPositionFromPoint
    ? document.caretPositionFromPoint.bind(document)
    : null;
  if (nativeCaret) {
    document.caretPositionFromPoint = (x, y) => {
      window.__hits.count += 1;
      const pos = nativeCaret(x, y);
      if (!window.__hits.failEvery || window.__hits.count % window.__hits.failEvery) return pos;
      const node = pos && pos.offsetNode;
      const host = (node && (node.nodeType === 3 ? node.parentElement : node))?.closest("p")
        || document.getElementById("notesView");
      return { offsetNode: host, offset: 0 };
    };
  }

  // ── Ground truth about where the lines actually are ──────────────────────
  //
  // Read the expensive way the controller cannot afford per frame:
  // getClientRects() on a text node gives one rect per LINE FRAGMENT, and those
  // tile vertically (they are line-box height) where caret rects do not (they
  // are text height). That difference is the whole reason a point can fall
  // between two caret rects and belong to neither.
  const paraNode = (marker) => {
    const p = Array.from(view.querySelectorAll("p")).find((n) => n.textContent.startsWith(marker));
    return p && p.firstChild && p.firstChild.nodeType === Node.TEXT_NODE ? p.firstChild : null;
  };

  window.__lineRect = (marker, index) => {
    const node = paraNode(marker);
    if (!node) return null;
    const r = document.createRange();
    r.selectNodeContents(node);
    const rects = Array.from(r.getClientRects()).filter((x) => x.width || x.height);
    const rect = rects[index];
    if (!rect) return null;
    return { count: rects.length, left: rect.left, right: rect.right, top: rect.top,
             bottom: rect.bottom, mid: rect.top + rect.height / 2 };
  };

  // The offsets at which each line begins — what "collapsed to the start of a
  // line" has to be compared against. One character at a time, on a fixture,
  // never on a hot path.
  window.__lineStarts = (marker) => {
    const node = paraNode(marker);
    if (!node) return [];
    const text = node.nodeValue || "";
    const starts = [0];
    const probe = document.createRange();
    let top = null;
    for (let i = 0; i < text.length; i += 1) {
      probe.setStart(node, i);
      probe.setEnd(node, i + 1);
      const rect = probe.getBoundingClientRect();
      if (!rect.height) continue;
      if (top !== null && rect.top > top + 1) starts.push(i);
      top = rect.top;
    }
    return starts;
  };

  // Where an offset actually sits, so an assertion can say "the resolved caret
  // is N pixels from the column the finger was in".
  window.__offsetX = (marker, offset) => {
    const node = paraNode(marker);
    if (!node) return null;
    const probe = document.createRange();
    probe.setStart(node, offset);
    probe.setEnd(node, offset);
    return probe.getBoundingClientRect().left;
  };

  // The controller's own hit-test, called directly. caretInRoot is exported and
  // touch-selection.js is already in API_SRC, so this needs no new plumbing —
  // and calling it directly bypasses extendTo's 1px guard, which makes it a
  // pure test of RESOLUTION rather than of the drag machinery around it.
  window.__caretAt = (x, y) => {
    const caret = api.caretInRoot(x, y, view);
    if (!caret) return null;
    const isText = caret.node.nodeType === Node.TEXT_NODE;
    const host = isText ? caret.node.parentElement : caret.node;
    const block = host && host.closest("p, li, h1, h2, h3, blockquote");
    return { offset: caret.offset, isText,
             marker: block ? block.textContent.slice(0, 5) : null };
  };

  // __captures counts times the pill threw its description of the selection
  // away and started again. positionNotesSelectionButton() resets the title to
  // the bare "Make a card" for each fresh capture, and ensurePillSelectionCapture
  // writes the word count onto it when that capture resolves — so a bare title
  // arriving while the pill is up is exactly one capture cycle.
  window.__captures = { count: 0 };
  const cardBtn = document.getElementById("makeCardFromSelectionBtn");
  new MutationObserver(() => {
    if (cardBtn.title === "Make a card" && !document.getElementById("selectionFloat").hidden) {
      window.__captures.count += 1;
    }
  }).observe(cardBtn, { attributes: true, attributeFilter: ["title"] });

  // The screen rect of the Nth word of the paragraph starting with \`marker\`.
  // Everything below aims at a point rather than at an element, because a finger
  // aims at a point.
  window.__wordRect = (marker, index) => {
    const target = Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith(marker));
    if (!target) return null;
    const node = target.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.nodeValue;
    const parts = [];
    const re = /[^\\s]+/g;
    let m = re.exec(text);
    while (m) { parts.push({ start: m.index, end: m.index + m[0].length, word: m[0] }); m = re.exec(text); }
    const part = parts[index];
    if (!part) return null;
    const range = document.createRange();
    range.setStart(node, part.start);
    range.setEnd(node, part.end);
    const rect = range.getBoundingClientRect();
    return { word: part.word, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
             left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  };

  window.__paraRect = (marker) => {
    const target = Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith(marker));
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  };

  // Bring a paragraph on screen, and say where the view ended up. A touch
  // dispatched at a point below the fold is delivered to nothing at all, and a
  // case that aims at one passes or fails for reasons that have nothing to do
  // with selection — so every case that names a paragraph calls this first.
  window.__reveal = (marker) => {
    const target = Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith(marker));
    if (!target) return null;
    const bounds = view.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    view.scrollTop += (r.top - bounds.top) - bounds.height / 2;
    return { scrollTop: view.scrollTop };
  };

  // Is a point actually inside the reading surface, and therefore reachable by
  // a dispatched touch? Asserted rather than assumed, because "the touch went
  // nowhere" and "the controller ignored it" look identical from the outside.
  // A dispatched touch carries a radius and Chrome hit-tests with it, so a
  // point a few pixels outside the surface still lands on it — which is the
  // whole point of the gutter case. The margin here is that radius.
  window.__reachable = (x, y, slop) => {
    const r = view.getBoundingClientRect();
    const pad = slop || 14;
    return x > r.left - pad && x < r.right + pad && y > r.top - pad && y < r.bottom + pad
      && x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight;
  };

  // Everything a case wants to know about the current selection, read the way
  // the APP reads it — through the range, never through Selection.toString(),
  // which is "" over the user-select: none the controller puts on this surface.
  window.__selection = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const startPara = (range.startContainer.parentElement || range.startContainer).closest("p");
    const endPara = (range.endContainer.parentElement || range.endContainer).closest("p");
    return {
      text: range.toString(),
      length: range.toString().length,
      startMarker: startPara ? startPara.textContent.slice(0, 5) : "",
      endMarker: endPara ? endPara.textContent.slice(0, 5) : "",
      startOffset: range.startOffset,
    };
  };

  // A handle's grip centre, and the caret rect it claims to mark. Case 2 is the
  // distance between the two.
  window.__handle = (which) => {
    const node = document.querySelector(".touch-select-handle.is-" + which);
    // A handle is taken off the glass by a CLASS, not by \`display\`: it keeps its
    // box so the controller can move it underneath the fade and let it come
    // back on its new boundary rather than blinking out and in.
    if (!node || node.classList.contains("is-hidden")) return null;
    const bulb = node.querySelector(".touch-select-bulb");
    const b = bulb.getBoundingClientRect();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const probe = sel.getRangeAt(0).cloneRange();
    probe.collapse(which === "start");
    const caret = probe.getBoundingClientRect();
    const stem = node.getBoundingClientRect();
    return {
      grabX: b.left + b.width / 2,
      grabY: b.top + b.height / 2,
      caretX: caret.left,
      caretY: caret.top + caret.height / 2,
      // The STEM is what has to sit on the caret; the bulb is the thumb rest,
      // deliberately below the line so a finger does not cover the text.
      stemLeft: stem.left + 21,
      stemTop: stem.top + 16,
    };
  };

  return { width: view.clientWidth, height: view.clientHeight, paragraphs: view.querySelectorAll("p").length };
}`;

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("touch-selection-check: no Chrome on this machine — skipping.");
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

    // ── Touch primitives ────────────────────────────────────────────────────
    const touchStart = (x, y) => page.call("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
    });
    const touchMove = (x, y) => page.call("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
    });
    const touchEnd = () => page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // A drag, in steps, because a single jump is not a gesture — the controller
    // re-derives the caret on every move and a one-frame drag would never
    // exercise that.
    const dragTo = async (fromX, fromY, toX, toY, steps = 8) => {
      for (let i = 1; i <= steps; i += 1) {
        await touchMove(fromX + ((toX - fromX) * i) / steps, fromY + ((toY - fromY) * i) / steps);
        await wait(24);
      }
    };

    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "boot" });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      console.log("touch-selection-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await wait(2000);

    // Everything below is gated on the controller having ARMED. A harness that
    // did not match the gate would pass every case for the wrong reason.
    const gate = await page.evaluate(() => ({
      media: window.matchMedia("(pointer: coarse) and (hover: none)").matches,
      touchPoints: navigator.maxTouchPoints,
      highlights: Boolean(window.CSS && window.CSS.highlights),
      armed: document.body.classList.contains("has-touch-select"),
    }));
    if (!gate.media || !gate.highlights) {
      console.log(`touch-selection-check: the gate cannot be satisfied under emulation (${JSON.stringify(gate)}) — nothing below would mean anything.`);
      return 1;
    }
    check(gate.armed, "the controller armed on an emulated phone", JSON.stringify(gate));

    const setup = await page.evaluate(new Function(`return (${SETUP_SRC})`)(), API_SRC);
    if (!setup || setup.paragraphs < 40) {
      console.log(`touch-selection-check: the fixture is ${setup ? `${setup.paragraphs} paragraphs` : "missing"} — nothing below would mean anything`);
      return 1;
    }
    ok("the fixture rendered", `${setup.paragraphs} paragraphs in ${setup.width}x${setup.height}`);

    // ── 0. The native gesture really is off ─────────────────────────────────
    const suppressed = await page.evaluate(() => ({
      userSelect: getComputedStyle(document.getElementById("notesView")).webkitUserSelect,
      overlay: Boolean(document.querySelector(".touch-select-layer")),
      handles: document.querySelectorAll(".touch-select-handle").length,
    }));
    check(suppressed.userSelect === "none",
      "the reading surface no longer offers the browser's own selection", `user-select: ${suppressed.userSelect}`);
    check(suppressed.overlay && suppressed.handles === 2,
      "the overlay and both handles exist", `${suppressed.handles} handles`);

    // The clip a pixel comparison is made over: the target word's own box,
    // captured before any selection exists so there is a baseline to differ
    // from. deviceScaleFactor is 2 under emulation, so scale: 1 asks for CSS
    // pixels and keeps the two images the same size.
    const shot = async (rect) => (await page.call("Page.captureScreenshot", {
      format: "png",
      clip: { x: rect.left - 2, y: rect.top - 2, width: rect.right - rect.left + 4, height: rect.bottom - rect.top + 4, scale: 1 },
    })).data;

    // What share of a box changed colour between two screenshots. Decoded and
    // compared IN THE PAGE, because that is where there is a canvas to do it
    // with. Used twice: once to prove the press paints, and once to prove a
    // DRAG repaints — see case 12.
    const diffShots = (before, after) => page.evaluate(async (a64, b64) => {
      const load = (data) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = "data:image/png;base64," + data;
      });
      const [a, b] = await Promise.all([load(a64), load(b64)]);
      const canvas = document.createElement("canvas");
      canvas.width = a.naturalWidth;
      canvas.height = a.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(a, 0, 0);
      const pa = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(b, 0, 0);
      const pb = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let changed = 0;
      for (let i = 0; i < pa.length; i += 4) {
        if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 24) changed += 1;
      }
      return { changed, total: pa.length / 4, width: canvas.width, height: canvas.height };
    }, before, after);

    // ── 1. A press becomes a selection, in a measured time ──────────────────
    //
    // The headline. "There is at least a 3-4s gap after I hard press and then
    // only selection starts" — with the timer ours, this is LONG_PRESS_MS plus
    // whatever the word snap and the first paint cost, and it does not depend on
    // the main thread being free the way the platform's own does.
    const word = await page.evaluate(() => window.__wordRect("P0004", 3));
    check(Boolean(word), "the target word was located", word ? `"${word.word}"` : "missing");
    const cleanShot = await shot(word);
    await touchStart(word.x, word.y);
    await wait(900);
    await touchEnd();
    // Read AFTER the lift, always. Reading while the finger was still down hid a
    // real bug for one iteration of this file: a touchend allowed its default
    // action synthesises mousedown, and Chrome answers that by collapsing the
    // selection — so the press worked and then undid itself ~50ms later. Every
    // case below therefore measures the state a reader is actually left holding.
    await wait(250);
    const pressTiming = await page.evaluate(() => ({ ...window.__press, sel: window.__selection() }));

    const latency = pressTiming.selectedAt - pressTiming.startedAt;
    check(pressTiming.selectedAt > 0 && latency < 600,
      "a press produces a selection promptly", `${latency.toFixed(0)}ms at ${THROTTLE}x CPU throttle`);
    check(pressTiming.sel && pressTiming.sel.text === word.word,
      "the press selected exactly the word under the finger",
      pressTiming.sel ? `"${pressTiming.sel.text}" vs "${word.word}"` : "nothing selected");

    // ── 1b. The selection is actually PAINTED ──────────────────────────────
    //
    // The one thing no API probe can answer. `user-select: none` stops the
    // browser painting its own selection highlight, and the whole design assumes
    // ::highlight() is unaffected by that — which is what the spec says and what
    // nothing short of looking at the screen can confirm. So: the same clip of
    // the same word, before and after, decoded in the page and compared pixel by
    // pixel.
    const paintedShot = await shot(word);
    const painted = await diffShots(cleanShot, paintedShot);
    const share = painted.total ? painted.changed / painted.total : 0;
    check(share > 0.3,
      "the selection is painted on the glass, not just held in a Range",
      `${(share * 100).toFixed(0)}% of the word's box changed colour (${painted.width}x${painted.height})`);

    // ── 2. The handles sit on the boundaries they mark ─────────────────────
    //
    // "The start and end indicators for the text selection is entirely
    // incorrect." Both handles are positioned from the same live Range the
    // highlight is painted from, so this is the assertion that the two cannot
    // drift apart.
    const handles = await page.evaluate(() => ({
      start: window.__handle("start"), end: window.__handle("end"),
    }));
    const handleError = (h) => (h ? Math.hypot(h.stemLeft - h.caretX, h.stemTop + 8 - h.caretY) : Infinity);
    check(handleError(handles.start) < 12,
      "the start handle sits on the start of the selection", `${handleError(handles.start).toFixed(1)}px off`);
    check(handleError(handles.end) < 12,
      "the end handle sits on the end of the selection", `${handleError(handles.end).toFixed(1)}px off`);
    check(handles.end && handles.end.grabY > handles.end.caretY,
      "the grip hangs below its line, so a thumb does not cover the text",
      handles.end ? `${(handles.end.grabY - handles.end.caretY).toFixed(0)}px below` : "no handle");

    // ── 3. The very start of a block ───────────────────────────────────────
    //
    // A press in the left gutter of a first line. caretPositionFromPoint
    // hit-tests into the block's padding there and answers with the CONTAINING
    // ELEMENT, which as a selection anchor lands in a neighbouring block — this
    // is "especially when I am starting selection from the very start of a
    // corner", and caretInRoot()'s repair is what this asserts.
    await page.evaluate(() => window.__reveal("P0012"));
    await wait(200);
    const para = await page.evaluate(() => window.__paraRect("P0012"));
    const first = await page.evaluate(() => window.__wordRect("P0012", 0));
    const gutterX = Math.max(2, para.left - 14);
    check(await page.evaluate((x, y) => window.__reachable(x, y), gutterX, first.y),
      "the gutter point is on screen", `${gutterX.toFixed(0)},${first.y.toFixed(0)}`);
    await touchStart(gutterX, first.y);
    await wait(700);
    await touchEnd();
    await wait(250);
    const cornerSel = await page.evaluate(() => window.__selection());
    check(cornerSel && cornerSel.startMarker === "P0012",
      "a press in the gutter anchors in the block it is beside",
      cornerSel ? `landed in ${cornerSel.startMarker}, selected "${cornerSel.text}"` : "nothing selected");
    check(cornerSel && cornerSel.startOffset === 0,
      "...and on that block's first character, not a few words in",
      cornerSel ? `offset ${cornerSel.startOffset}` : "nothing selected");

    // ── 3b. Sweeping a caret DOWN THROUGH A LINE BOUNDARY ──────────────────
    //
    // The reported bug, as a measurement: "selecting content inter line is not
    // reliable — it jumps to the start of a line."
    //
    // Nothing here drove the hit-test directly before, so nothing could see what
    // it answers between two lines. It answers badly, for two independent
    // reasons. caret rects are TEXT height and do not tile, so there is a band
    // of y between one line's caret rects and the next line's where the
    // comparator in offsetNear degenerates to "line N: before, line N+1: after"
    // with x ignored entirely — and converges on the first offset of line N+1.
    // And when the platform hit-test fails (case 3c), the repair ladder used to
    // probe the edge of the content box, which at this app's default reading
    // width lands inside the first character of the line and is accepted as a
    // perfectly usable caret.
    //
    // Both produce the same wrong answer: column 0. The assertions below are
    // about the COLUMN, because that is what the reader sees — the offset stays
    // roughly in order either way, which is why a test that only watched the
    // offset would have passed.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => window.__reveal("L0000"));
    await wait(250);

    const sweepLines = await page.evaluate(() => ({
      a: window.__lineRect("L0000", 1),
      b: window.__lineRect("L0000", 2),
      starts: window.__lineStarts("L0000"),
    }));
    if (!sweepLines.a || !sweepLines.b) {
      fail("the fixture paragraph wraps to enough lines to sweep across",
        `line count ${sweepLines.a ? sweepLines.a.count : "?"}`);
    } else {
      ok("the fixture paragraph has an interior line boundary", `${sweepLines.a.count} lines`);
      // A fixed column, well inside both lines, so "the answer tracks x" has
      // something to mean. 0.62 rather than 0.5 so a half-width coincidence
      // cannot pass by accident.
      const sweepX = sweepLines.a.left + (sweepLines.a.right - sweepLines.a.left) * 0.62;

      const sweepFrom = async (label, failEvery, slackPx) => {
        const samples = await page.evaluate(async (x, y0, y1, every) => {
          window.__hits.failEvery = every;
          const out = [];
          for (let y = y0; y <= y1; y += 1) {
            const caret = window.__caretAt(x, y);
            out.push(caret ? { ...caret, screenX: window.__offsetX("L0000", caret.offset) } : null);
          }
          window.__hits.failEvery = 0;
          return out;
        }, sweepX, Math.round(sweepLines.a.mid), Math.round(sweepLines.b.mid), failEvery);

        const missing = samples.filter((v) => !v || !v.isText || v.marker !== "L0000").length;
        check(missing === 0, `${label}: every point between two lines resolves inside the paragraph`,
          `${samples.length - missing}/${samples.length} resolved`);

        const collapsed = samples.filter((v) => v && sweepLines.starts.includes(v.offset));
        check(collapsed.length === 0, `${label}: ...and never to the first offset of a line`,
          `${collapsed.length}/${samples.length} collapsed to a line start`);

        // The strongest of the three, and the one a reader would describe: the
        // caret has to stay in the COLUMN the finger is in.
        const strays = samples.filter((v) => v && Number.isFinite(v.screenX)
          && Math.abs(v.screenX - sweepX) > slackPx);
        const worst = strays.reduce((m, v) => Math.max(m, Math.abs(v.screenX - sweepX)), 0);
        check(strays.length === 0, `${label}: ...and tracks the finger's column`,
          `${strays.length}/${samples.length} strayed, worst ${Math.round(worst)}px (slack ${slackPx}px)`);

        const back = samples.filter((v, i) => i > 0 && v && samples[i - 1] && v.offset < samples[i - 1].offset);
        check(back.length === 0, `${label}: ...and never runs backwards down the sweep`,
          `${back.length} regressions`);
      };

      // One character plus slop at the fixture's size. A gap sample that has
      // collapsed to column 0 is out by ~0.62 of the line width — ~200px.
      await sweepFrom("across a line boundary", 0, 14);
      // ...and again with the platform hit-test failing every third call, which
      // is the only way to drive the repair ladder deterministically. The slack
      // is the largest nudge the repair is allowed to wander.
      await sweepFrom("across a line boundary, hit-test failing", 3, 26);
    }

    // ── 3c. ...and down through a BLOCK MARGIN ─────────────────────────────
    //
    // The other half, and the one that needs no injected fault at all: measured
    // in Chromium 141, caretPositionFromPoint in the margin BETWEEN two blocks
    // answers with offset 0 of the FOLLOWING block, regardless of x. That is a
    // text node inside the view, so usableCaret accepts it and caretInRoot
    // returns it on the very first probe — the repair ladder never runs and the
    // code has no idea anything went wrong. A drag sweeps through those margins
    // constantly.
    {
      // Scrolled into view FIRST. A rect read for a block the reader is nowhere
      // near is a coordinate outside the viewport, and probing there hit
      // whatever paragraph happened to be on screen instead — the case passed
      // for the wrong reason until this line existed.
      await page.evaluate(() => window.__reveal("P0030"));
      await wait(300);
      const gap = await page.evaluate(() => {
        const ps = Array.from(document.getElementById("notesView").querySelectorAll("p"));
        const a = ps.find((n) => n.textContent.startsWith("P0030"));
        const b = ps.find((n) => n.textContent.startsWith("P0031"));
        if (!a || !b) return null;
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return { bottom: ar.bottom, top: br.top, left: ar.left, right: ar.right,
                 onScreen: ar.bottom > 0 && br.top < window.innerHeight };
      });
      if (gap && !gap.onScreen) fail("the probe paragraphs are on screen", JSON.stringify(gap));
      if (!gap || gap.top - gap.bottom < 2) {
        ok("the two probe paragraphs have a margin between them", gap ? `${(gap.top - gap.bottom).toFixed(1)}px` : "not found");
      } else {
        const marginX = gap.left + (gap.right - gap.left) * 0.62;
        const samples = await page.evaluate((x, y0, y1) => {
          const out = [];
          for (let y = y0; y <= y1; y += 1) out.push(window.__caretAt(x, y));
          return out;
        }, marginX, Math.round(gap.bottom - 2), Math.round(gap.top + 2));
        const zeros = samples.filter((v) => v && v.offset === 0);
        check(zeros.length === 0,
          "a point in the margin between two paragraphs does not resolve to the start of one",
          `${zeros.length}/${samples.length} landed on offset 0 (gap ${(gap.top - gap.bottom).toFixed(1)}px)`);
      }
    }

    // ── 4. Dragging a handle extends the selection ─────────────────────────
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => window.__reveal("P0020"));
    await wait(250);
    const anchorWord = await page.evaluate(() => window.__wordRect("P0020", 2));
    await touchStart(anchorWord.x, anchorWord.y);
    await wait(700);
    await touchEnd();
    await wait(200);
    const beforeDrag = await page.evaluate(() => window.__selection());
    const endGrip = await page.evaluate(() => window.__handle("end"));
    const targetWord = await page.evaluate(() => window.__wordRect("P0022", 5));
    check(Boolean(beforeDrag && endGrip && targetWord), "a selection to drag from",
      beforeDrag ? `"${beforeDrag.text}"` : "none");

    await touchStart(endGrip.grabX, endGrip.grabY);
    await dragTo(endGrip.grabX, endGrip.grabY,
      targetWord.right, targetWord.y + (endGrip.grabY - endGrip.caretY));
    await touchEnd();
    await wait(300);
    const afterDrag = await page.evaluate(() => window.__selection());
    check(afterDrag && afterDrag.length > beforeDrag.length,
      "dragging the end handle extends the selection",
      afterDrag ? `${beforeDrag.length} -> ${afterDrag.length} chars` : "selection lost");
    check(afterDrag && afterDrag.endMarker === "P0022",
      "...as far as the paragraph the handle was dragged to",
      afterDrag ? `ends in ${afterDrag.endMarker}` : "selection lost");
    check(afterDrag && afterDrag.startMarker === "P0020",
      "...without moving the end that was not being dragged",
      afterDrag ? `starts in ${afterDrag.startMarker}` : "selection lost");

    // The handles are still on the boundaries after all that movement, which is
    // the half of case 2 that a static selection cannot prove.
    const dragged = await page.evaluate(() => ({ start: window.__handle("start"), end: window.__handle("end") }));
    check(handleError(dragged.start) < 12 && handleError(dragged.end) < 12,
      "both handles still sit on the boundaries after a drag",
      `start ${handleError(dragged.start).toFixed(1)}px, end ${handleError(dragged.end).toFixed(1)}px`);

    // ── 5. Dragging back across the anchor swaps the ends ──────────────────
    const crossGrip = await page.evaluate(() => window.__handle("end"));
    const above = await page.evaluate(() => window.__wordRect("P0018", 1));
    await touchStart(crossGrip.grabX, crossGrip.grabY);
    await dragTo(crossGrip.grabX, crossGrip.grabY,
      above.x, above.y + (crossGrip.grabY - crossGrip.caretY));
    await touchEnd();
    await wait(300);
    const crossed = await page.evaluate(() => window.__selection());
    check(crossed && crossed.startMarker === "P0018" && crossed.endMarker === "P0020",
      "dragging back past the anchor swaps the two ends",
      crossed ? `${crossed.startMarker} -> ${crossed.endMarker}` : "selection lost");

    // ── 5b. Containment really is suspended DURING the drag ────────────────
    //
    // tools/mobile-selection-check.mjs asserts this by hand-marking the drag
    // flag, because on that path there was no gesture it could drive. Here
    // there is: the state below is read from inside a real handle drag, between
    // two touchMoves, with a finger still down.
    //
    // What it is guarding is the other half of "the indicators are wrong". Every
    // notes block stands in at an ESTIMATED height until it is first laid out
    // (styles/12-notes.css), so a drag reaching unread text replaces the
    // estimate with the real height and the document moves under the finger.
    const midDrag = await (async () => {
      await page.evaluate(() => window.getSelection().removeAllRanges());
      await page.evaluate(() => window.__reveal("P0050"));
      await wait(250);
      const seed = await page.evaluate(() => window.__wordRect("P0050", 2));
      await touchStart(seed.x, seed.y);
      await wait(700);
      await touchEnd();
      await wait(250);
      const grip = await page.evaluate(() => window.__handle("end"));
      const down = await page.evaluate(() => window.__wordRect("P0052", 4));
      await touchStart(grip.grabX, grip.grabY);
      await touchMove(down.x, down.y + (grip.grabY - grip.caretY));
      await wait(120);
      const during = await page.evaluate(() => ({
        selecting: document.body.classList.contains("is-selecting"),
        touchSelecting: document.body.classList.contains("is-touch-selecting"),
        // The block under the drag is freed individually now, not the whole
        // view — see markSelectionStableRegion. Asserting the computed value on
        // that block is strictly stronger than asserting the class was set.
        freed: (() => {
          const view = document.getElementById("notesView");
          const sel = window.getSelection();
          const node = sel && sel.focusNode;
          let el = node && (node.nodeType === 1 ? node : node.parentElement);
          while (el && el.parentElement !== view) el = el.parentElement;
          return el ? getComputedStyle(el).contentVisibility : "(no block)";
        })(),
        touchAction: getComputedStyle(document.getElementById("notesView")).touchAction,
      }));
      await touchEnd();
      await wait(300);
      const after = await page.evaluate(() => ({
        selecting: document.body.classList.contains("is-selecting"),
        touchAction: getComputedStyle(document.getElementById("notesView")).touchAction,
      }));
      return { during, after };
    })();
    check(midDrag.during.selecting && midDrag.during.freed === "visible",
      "containment is suspended while a handle is actually being dragged",
      `is-selecting: ${midDrag.during.selecting}, block under the drag: ${midDrag.during.freed}`);
    check(midDrag.during.touchAction === "none",
      "...and the surface cannot scroll out from under the drag",
      `touch-action: ${midDrag.during.touchAction}`);
    check(!midDrag.after.selecting && midDrag.after.touchAction !== "none",
      "both are handed straight back when the finger lifts",
      `is-selecting: ${midDrag.after.selecting}, touch-action: ${midDrag.after.touchAction}`);

    // ── 6. A quick flick still scrolls, and selects nothing ────────────────
    //
    // The other side of case 1. A press timer that fires too eagerly turns every
    // scroll into a selection, which would be a worse bug than the one being
    // fixed.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await wait(150);
    await page.evaluate(() => window.__reveal("P0030"));
    await wait(250);
    // Read AFTER the reveal: the reveal is itself a scroll, and a baseline taken
    // before it compares two different places in the note.
    const beforeFlick = await page.evaluate(() => document.getElementById("notesView").scrollTop);
    const flickFrom = await page.evaluate(() => window.__wordRect("P0030", 2));
    await touchStart(flickFrom.x, flickFrom.y);
    await dragTo(flickFrom.x, flickFrom.y, flickFrom.x, flickFrom.y - 220, 6);
    await touchEnd();
    await wait(500);
    const flick = await page.evaluate(() => ({
      scrollTop: document.getElementById("notesView").scrollTop,
      sel: window.__selection(),
      selecting: document.body.classList.contains("is-touch-selecting"),
    }));
    check(flick.scrollTop > beforeFlick,
      "a quick flick still scrolls the note", `${beforeFlick} -> ${flick.scrollTop}`);
    check(!flick.sel && !flick.selecting,
      "...and selects nothing", flick.sel ? `selected "${flick.sel.text}"` : "nothing selected");

    // ── 6b. A press that fired too early is given back as a scroll ─────────
    //
    // The safety net under LONG_PRESS_MS being 240ms rather than 320ms. A
    // reader who rests a moment before scrolling now trips the press timer, and
    // the escape (PRESS_ESCAPE_MS / PRESS_ESCAPE_PX) is what stops that costing
    // them the scroll: leave fast, straight after the buzz, and the word is
    // unselected and the surface follows the finger instead.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await wait(150);
    await page.evaluate(() => window.__reveal("P0034"));
    await wait(250);
    const beforeEscape = await page.evaluate(() => document.getElementById("notesView").scrollTop);
    const escapeFrom = await page.evaluate(() => window.__wordRect("P0034", 2));
    await touchStart(escapeFrom.x, escapeFrom.y);
    // Long enough for the press to fire (240ms) and no longer: this is the
    // hesitation that used to be too short to select and now is not.
    await wait(300);
    await dragTo(escapeFrom.x, escapeFrom.y, escapeFrom.x, escapeFrom.y - 220, 6);
    await touchEnd();
    await wait(400);
    const escaped = await page.evaluate(() => ({
      scrollTop: document.getElementById("notesView").scrollTop,
      sel: window.__selection(),
      selecting: document.body.classList.contains("is-touch-selecting"),
      dragging: document.body.classList.contains("is-touch-dragging"),
    }));
    check(!escaped.sel && !escaped.selecting && !escaped.dragging,
      "a scroll that began with a hesitation keeps no selection",
      escaped.sel ? `selected "${escaped.sel.text}"` : "nothing selected");
    check(escaped.scrollTop > beforeEscape,
      "...and the note scrolls anyway, driven by us once the escape fires",
      `${beforeEscape} -> ${escaped.scrollTop}`);

    // ── 6c. ...but a deliberate press-and-slide still selects ──────────────
    //
    // The escape only looks at the moments right after the press. A reader who
    // holds, feels the word take, and then slides is past the window, and their
    // slide has to extend the selection rather than throw it away.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await wait(150);
    const slideFrom = await page.evaluate(() => window.__wordRect("P0038", 1));
    const beforeSlide = await page.evaluate(() => document.getElementById("notesView").scrollTop);
    await touchStart(slideFrom.x, slideFrom.y);
    await wait(600);
    await dragTo(slideFrom.x, slideFrom.y, slideFrom.x + 180, slideFrom.y, 6);
    await touchEnd();
    await wait(300);
    const slid = await page.evaluate(() => ({
      scrollTop: document.getElementById("notesView").scrollTop,
      sel: window.__selection(),
    }));
    check(slid.sel && slid.sel.text.length > 6,
      "a press held past the escape window still slides into a selection",
      slid.sel ? `"${slid.sel.text}"` : "nothing selected");
    check(slid.scrollTop === beforeSlide,
      "...and the surface stayed put under it", `${beforeSlide} -> ${slid.scrollTop}`);

    // ── 7. Auto-scroll at the edge ─────────────────────────────────────────
    //
    // Without it a selection can never be longer than one screenful, because
    // there is no way to reach past the bottom of the glass.
    await page.evaluate(() => { document.getElementById("notesView").scrollTop = 0; });
    await wait(200);
    const edgeWord = await page.evaluate(() => window.__wordRect("P0002", 2));
    await touchStart(edgeWord.x, edgeWord.y);
    await wait(700);
    await touchEnd();
    await wait(200);
    const edgeGrip = await page.evaluate(() => window.__handle("end"));
    const beforeEdge = await page.evaluate(() => ({
      scrollTop: document.getElementById("notesView").scrollTop,
      length: window.__selection() ? window.__selection().length : 0,
    }));
    const viewBottom = await page.evaluate(() => {
      const r = document.getElementById("notesView").getBoundingClientRect();
      return r.bottom;
    });
    await touchStart(edgeGrip.grabX, edgeGrip.grabY);
    await dragTo(edgeGrip.grabX, edgeGrip.grabY, edgeGrip.grabX, viewBottom - 12, 6);
    // Hold at the edge: the rAF loop keeps scrolling from the last point, which
    // is exactly how a reader reaches the next page without lifting a finger.
    await wait(900);
    const duringEdge = await page.evaluate(() => ({
      scrollTop: document.getElementById("notesView").scrollTop,
      length: window.__selection() ? window.__selection().length : 0,
    }));
    await touchEnd();
    await wait(300);
    check(duringEdge.scrollTop > beforeEdge.scrollTop,
      "a drag into the bottom edge scrolls the note",
      `${beforeEdge.scrollTop} -> ${duringEdge.scrollTop}`);
    check(duringEdge.length > beforeEdge.length,
      "...and the selection keeps growing as it goes",
      `${beforeEdge.length} -> ${duringEdge.length} chars`);

    // ── 8. The app still recognises the selection as its own ───────────────
    //
    // The whole design rests on this: our range is MIRRORED into the real
    // Selection, and every reader in the app goes through getRangeAt(0) plus
    // Range operations, all of which stay correct over user-select: none. If any
    // of these came back empty the pill, the highlighter, the cloze driver and
    // make-card would all be dead on a phone.
    const mirror = await page.evaluate(() => {
      const api = window.__recall.api;
      const target = api.activeRenderedTarget();
      const range = target ? api.notesSelectionRange(target) : null;
      const strings = api.renderedSelectionStrings(document.getElementById("notesView"));
      return {
        targetName: target ? target.name : null,
        rangeText: range ? range.toString().slice(0, 40) : null,
        asText: strings ? strings.asText.slice(0, 40) : null,
        pillHidden: document.getElementById("selectionFloat").hidden,
      };
    });
    check(mirror.targetName === "notes", "activeRenderedTarget() finds the selection", `${mirror.targetName}`);
    check(Boolean(mirror.rangeText), "notesSelectionRange() returns the range", `"${mirror.rangeText}"`);
    check(Boolean(mirror.asText), "renderedSelectionStrings() describes it", `"${mirror.asText}"`);
    check(mirror.pillHidden === false, "the selection pill is up once the finger lifts",
      `hidden: ${mirror.pillHidden}`);

    // ── 9. The three buttons that replace the platform's bar ───────────────
    const bar = await page.evaluate(() => {
      const api = window.__recall.api;
      const btn = (id) => document.getElementById(id);
      return {
        copy: Boolean(btn("copySelectionBtn")),
        search: Boolean(btn("searchSelectionBtn")),
        // Removed rather than hidden where navigator.share is absent, which is
        // the case in headless Chrome — so its ABSENCE is the assertion here.
        shareInDom: Boolean(btn("shareSelectionBtn")),
        shareSupported: Boolean(navigator.share),
        text: api.currentSelectionPlainText().slice(0, 40),
      };
    });
    check(bar.copy && bar.search, "Copy and Web search are on the bar",
      `copy: ${bar.copy}, search: ${bar.search}`);
    check(bar.shareInDom === bar.shareSupported,
      "Share is present exactly when the platform can share",
      `in DOM: ${bar.shareInDom}, navigator.share: ${bar.shareSupported}`);
    check(Boolean(bar.text), "the buttons can read the selection as plain text", `"${bar.text}"`);

    // ── 10. A tap outside dismisses, a tap inside does not ─────────────────
    //
    // Both halves, because they are the same branch. A tap inside the selection
    // has to leave it alone — that is a reader reaching for a handle, and
    // dismissing there would make the handles unreachable by the only gesture
    // that can grab them.
    //
    // Starting from a fresh ONE-WORD selection on purpose. The selection left by
    // the auto-scroll case covers most of the screen, so "somewhere outside it"
    // is not a point that exists.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => window.__reveal("P0040"));
    await wait(250);
    const lone = await page.evaluate(() => window.__wordRect("P0040", 2));
    await touchStart(lone.x, lone.y);
    await wait(700);
    await touchEnd();
    await wait(250);

    const inside = await page.evaluate(() => window.__selection());
    await touchStart(lone.x, lone.y);
    await touchEnd();
    await wait(300);
    const stillThere = await page.evaluate(() => window.__selection());
    check(Boolean(inside) && Boolean(stillThere) && stillThere.text === inside.text,
      "a tap inside the selection leaves it alone, so a handle stays reachable",
      stillThere ? `"${stillThere.text}"` : "cleared");

    const away = await page.evaluate(() => window.__wordRect("P0043", 2));
    await touchStart(away.x, away.y);
    await touchEnd();
    await wait(300);
    const dismissed = await page.evaluate(() => ({
      sel: window.__selection(),
      selecting: document.body.classList.contains("is-touch-selecting"),
      handles: Array.from(document.querySelectorAll(".touch-select-handle"))
        .filter((h) => !h.classList.contains("is-hidden")).length,
      // The CLASS is what the controller writes; this is what the reader sees.
      // Worth both, because a handle is hidden by opacity rather than by
      // `display` now, and `.is-parked` sets an opacity of its own at the same
      // specificity — a stale parked class on a hidden grip would leave it on
      // screen at 75%, attached to a selection that no longer exists.
      opacity: Array.from(document.querySelectorAll(".touch-select-handle"))
        .map((h) => Number(getComputedStyle(h).opacity)),
    }));
    check(!dismissed.sel && !dismissed.selecting && dismissed.handles === 0,
      "a tap outside the selection clears it, handles included",
      `handles still shown: ${dismissed.handles}`);
    check(dismissed.opacity.every((o) => o === 0),
      "...and the dismissed handles are actually invisible, not merely marked",
      `opacity: ${dismissed.opacity.join(", ")}`);

    // ═══════════════════════════════════════════════════════════════════════
    // The second report: "it somehow worked ... but a unstable visual
    // behaviour ... it is not persistent, like when I am selecting and scroll
    // to select more it forgets the previous selections ... it feels a little
    // flickering."
    //
    // Everything above says the gesture WORKS. Cases 11-15 are about whether it
    // is steady, which is a different question and needs different assertions:
    // what survives, what moves, and how much work one drag costs.
    // ═══════════════════════════════════════════════════════════════════════

    // ── 11. A selection survives a scroll ──────────────────────────────────
    //
    // The headline of the second report. The dismissal used to be decided on
    // the TOUCHSTART, and a scroll begins with a touch outside the selection —
    // so scrolling to reach the rest of the passage you were selecting threw it
    // away before your finger had moved. A tap must still dismiss (case 10
    // above, unchanged); a scroll must not.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => window.__reveal("P0050"));
    await wait(250);
    const keepWord = await page.evaluate(() => window.__wordRect("P0050", 3));
    await touchStart(keepWord.x, keepWord.y);
    await wait(700);
    await touchEnd();
    await wait(250);
    const beforeScroll = await page.evaluate(() => ({
      sel: window.__selection(),
      scrollTop: document.getElementById("notesView").scrollTop,
    }));
    check(Boolean(beforeScroll.sel), "a selection to scroll away from",
      beforeScroll.sel ? `"${beforeScroll.sel.text}"` : "none");

    // A scroll gesture: a touch well outside the selection, dragged far enough
    // to be unmistakable, and released.
    const scrollFrom = await page.evaluate(() => window.__wordRect("P0053", 2));
    await touchStart(scrollFrom.x, scrollFrom.y);
    await dragTo(scrollFrom.x, scrollFrom.y, scrollFrom.x, scrollFrom.y - 200, 8);
    // Read mid-gesture: the handles come off the glass while the words are
    // moving, because a fixed overlay moved by JavaScript cannot keep up with a
    // surface that scrolls on the compositor. That swim is the flicker.
    const midScroll = await page.evaluate(() => ({
      scrolling: document.body.classList.contains("is-touch-scrolling"),
      opacity: getComputedStyle(document.querySelector(".touch-select-handle.is-end")).opacity,
      sel: window.__selection(),
    }));
    await touchEnd();
    await wait(400);
    const afterScroll = await page.evaluate(() => ({
      sel: window.__selection(),
      scrollTop: document.getElementById("notesView").scrollTop,
      scrolling: document.body.classList.contains("is-touch-scrolling"),
      selecting: document.body.classList.contains("is-touch-selecting"),
    }));
    check(afterScroll.scrollTop !== beforeScroll.scrollTop,
      "the note scrolled", `${beforeScroll.scrollTop} -> ${afterScroll.scrollTop}`);
    check(Boolean(afterScroll.sel) && beforeScroll.sel
      && afterScroll.sel.text === beforeScroll.sel.text
      && afterScroll.sel.startMarker === beforeScroll.sel.startMarker,
      "...and the selection is still exactly the one that was there before it",
      afterScroll.sel ? `"${afterScroll.sel.text}"` : "the selection was thrown away");
    check(midScroll.scrolling && Number(midScroll.opacity) === 0,
      "the handles come off the glass while the text is moving",
      `is-touch-scrolling: ${midScroll.scrolling}, handle opacity: ${midScroll.opacity}`);
    check(!afterScroll.scrolling && afterScroll.selecting,
      "...and are handed back once the view settles",
      `is-touch-scrolling: ${afterScroll.scrolling}`);

    // ── 11b. The grips do not blink for a scroll the reader did not make ───
    //
    // onRootScroll takes the handles off the glass for the duration of a scroll,
    // which is right for a fling and wrong for the app's own scrollTop writes:
    // settleNotesPin corrects the reading position after every edit, and
    // measureNotesChunkEstimate changes heights above the viewport so the
    // browser's own scroll anchoring writes scrollTop to compensate. In both the
    // content does not move — there is nothing for a grip to trail — and both
    // used to fade the grips out for 120ms and back. That is the "the two round
    // handles flicker" report.
    {
      const blink = await page.evaluate(async () => {
        const view = document.getElementById("notesView");
        let sawFade = 0;
        const watch = new MutationObserver(() => {
          if (document.body.classList.contains("is-touch-scrolling")) sawFade += 1;
        });
        watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        // Announced, the way every deliberate app scroll announces itself.
        window.__recall.api.markProgrammaticNotesScroll(400);
        // Eight pixels a step, not one: a smaller move would be inside
        // selectionMovedOnGlass()'s tolerance and the case would pass without
        // ever exercising the guard it is about.
        for (let i = 0; i < 6; i += 1) {
          view.scrollTop += 8;
          await new Promise((r) => setTimeout(r, 30));
        }
        await new Promise((r) => setTimeout(r, 250));
        watch.disconnect();
        return { sawFade, selecting: document.body.classList.contains("is-touch-selecting") };
      });
      check(blink.selecting && blink.sawFade === 0,
        "a scroll the app made does not fade the grips",
        `is-touch-scrolling set ${blink.sawFade} time(s)`);
    }

    // ── 11c. Nor does the platform paint its own selection over ours ───────
    //
    // user-select is inherited, so the surface-wide suppression only reaches
    // elements that do not state their own value — and `.cloze.is-revealed`
    // does (styles/06-rendered.css:122, because a revealed cloze IS selectable
    // with a mouse). The browser kept painting ::selection over one while our
    // own ::highlight tinted it, in a different colour, appearing and
    // disappearing as a drag crossed it.
    {
      const paint = await page.evaluate(() => {
        const view = document.getElementById("notesView");
        const p = view.querySelector("p");
        if (!p) return null;
        const span = document.createElement("span");
        span.className = "cloze is-revealed";
        span.textContent = "revealed";
        p.appendChild(span);
        const probe = {
          cloze: getComputedStyle(span).webkitUserSelect,
          tapHighlight: getComputedStyle(view).webkitTapHighlightColor,
        };
        span.remove();
        return probe;
      });
      check(paint && paint.cloze === "none",
        "a revealed cloze is not selectable by the browser either",
        paint ? `user-select: ${paint.cloze}` : "no paragraph to test on");
      check(paint && /rgba\(0, 0, 0, 0\)|transparent/.test(paint.tapHighlight),
        "...and a press does not flash the platform's tap highlight",
        paint ? paint.tapHighlight : "");
    }

    // ── 12. Handles land back on the boundaries, and the paint follows ──────
    //
    // Two things a scroll could have broken. The grips are placed from the live
    // Range after the settle, so they must be on the boundaries again — and the
    // highlight is registered ONCE now rather than re-registered on every drag
    // frame, so this is also the assertion that a live Range in a Highlight
    // really does repaint when its boundaries move.
    const settled = await page.evaluate(() => ({
      start: window.__handle("start"), end: window.__handle("end"),
    }));
    const settledError = (h) => (h ? Math.hypot(h.stemLeft - h.caretX, h.stemTop + 8 - h.caretY) : Infinity);
    check(settledError(settled.end) < 12 || settled.end === null,
      "a handle still on screen is back on its boundary after the scroll",
      settled.end ? `${settledError(settled.end).toFixed(1)}px off` : "parked or off screen");

    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => window.__reveal("P0060"));
    await wait(250);
    const paintAnchor = await page.evaluate(() => window.__wordRect("P0060", 1));
    const paintTarget = await page.evaluate(() => window.__wordRect("P0060", 5));
    const cleanFar = await shot(paintTarget);
    await touchStart(paintAnchor.x, paintAnchor.y);
    await wait(700);
    await touchEnd();
    await wait(250);
    const paintGrip = await page.evaluate(() => window.__handle("end"));
    await touchStart(paintGrip.grabX, paintGrip.grabY);
    await dragTo(paintGrip.grabX, paintGrip.grabY,
      paintTarget.right, paintTarget.y + (paintGrip.grabY - paintGrip.caretY), 6);
    await touchEnd();
    await wait(300);
    const draggedShot = await shot(paintTarget);
    const dragPaint = await diffShots(cleanFar, draggedShot);
    const dragShare = dragPaint.total ? dragPaint.changed / dragPaint.total : 0;
    check(dragShare > 0.3,
      "a word dragged INTO the selection is repainted, so the live Range still drives the highlight",
      `${(dragShare * 100).toFixed(0)}% of the word's box changed colour (${dragPaint.width}x${dragPaint.height})`);

    // ── 13. A boundary scrolled off keeps a parked grip ─────────────────────
    //
    // "Scroll to select more" needs something to grab after the scroll. A
    // handle whose boundary has left the surface used to be hidden outright,
    // which meant that past one screenful the only way to extend was to scroll
    // back to the grip that had gone.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => window.__reveal("P0064"));
    await wait(250);
    const parkWord = await page.evaluate(() => window.__wordRect("P0064", 3));
    await touchStart(parkWord.x, parkWord.y);
    await wait(700);
    await touchEnd();
    await wait(250);
    const parkBefore = await page.evaluate(() => window.__selection());
    // Scroll the selection off the TOP, programmatically: this case is about
    // where the handle ends up, not about the gesture that got it there.
    await page.evaluate(() => { document.getElementById("notesView").scrollTop += 700; });
    await wait(400);
    const parked = await page.evaluate(() => {
      const node = document.querySelector(".touch-select-handle.is-start");
      const view = document.getElementById("notesView");
      const r = node.getBoundingClientRect();
      const bounds = view.getBoundingClientRect();
      return {
        hidden: node.classList.contains("is-hidden"),
        parked: node.classList.contains("is-parked"),
        // The stem's own top, past the 16px transparent grab border.
        stemTop: r.top + 16,
        viewTop: bounds.top,
        viewBottom: bounds.bottom,
        sel: window.__selection(),
      };
    });
    check(Boolean(parked.sel) && parkBefore && parked.sel.text === parkBefore.text,
      "the selection survives being scrolled off the top",
      parked.sel ? `"${parked.sel.text}"` : "lost");
    check(!parked.hidden && parked.parked,
      "...and its start handle is parked rather than hidden",
      `hidden: ${parked.hidden}, parked: ${parked.parked}`);
    check(parked.stemTop >= parked.viewTop - 2 && parked.stemTop <= parked.viewBottom,
      "...clamped inside the reading surface, not floating over the toolbar",
      `stem at ${parked.stemTop.toFixed(0)}, surface ${parked.viewTop.toFixed(0)}..${parked.viewBottom.toFixed(0)}`);

    // Grabbing a parked grip drags from where the FINGER is — its own caret is
    // off screen, so the measured finger-to-caret offset a normal grab uses
    // would aim at nothing.
    const parkGrip = await page.evaluate(() => {
      const bulb = document.querySelector(".touch-select-handle.is-start .touch-select-bulb");
      const b = bulb.getBoundingClientRect();
      return { grabX: b.left + b.width / 2, grabY: b.top + b.height / 2 };
    });
    //
    // The anchor it drags against is the OTHER boundary, which is off the top
    // of the screen — so every reachable point is past it and the two ends
    // swap, exactly as case 5 asserts for a handle dragged past its anchor in
    // view. What is being asserted is that the boundary the reader grabbed
    // arrives where their finger went.
    const parkTarget = await page.evaluate(() => window.__wordRect("P0071", 2));
    await touchStart(parkGrip.grabX, parkGrip.grabY);
    await dragTo(parkGrip.grabX, parkGrip.grabY, parkTarget.x, parkTarget.y, 8);
    await touchEnd();
    await wait(300);
    const parkAfter = await page.evaluate(() => window.__selection());
    check(Boolean(parkAfter) && parkAfter.endMarker === "P0071" && parkAfter.length > parkBefore.length,
      "dragging a parked handle brings that boundary to the finger",
      parkAfter ? `${parkBefore.length} -> ${parkAfter.length} chars, reaching ${parkAfter.endMarker}` : "selection lost");

    // ── 14. One extend per frame ───────────────────────────────────────────
    //
    // The drag used to run its whole pass — a hit-test, a binary search that
    // forces layout at every step, and a containment pass that writes classes —
    // synchronously off every touchmove, which on a 120Hz phone is up to twice
    // a frame, with the reads and the writes interleaved. That is layout
    // thrash, and it is what a stuttering drag is.
    //
    // The burst has to be dispatched FROM THE PAGE, in one task. A move sent
    // over the DevTools protocol costs tens of milliseconds of round trip, so
    // every one of them lands in a frame of its own and the coalesced version
    // and the eager one do identical work — the difference this is about only
    // exists when the events arrive faster than the display refreshes, which on
    // a 120Hz phone is what a real drag does. The touch itself is real: the
    // press below comes from Input.dispatchTouchEvent and the finger is still
    // down while the burst runs.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.evaluate(() => window.__reveal("P0074"));
    await wait(250);
    const burstWord = await page.evaluate(() => window.__wordRect("P0074", 2));
    await touchStart(burstWord.x, burstWord.y);
    await wait(700);
    const burst = await page.evaluate((x, y) => {
      const view = document.getElementById("notesView");
      window.__hits.count = 0;
      for (let i = 1; i <= 30; i += 1) {
        const touch = new Touch({ identifier: 1, target: view, clientX: x, clientY: y + i * 4 });
        view.dispatchEvent(new TouchEvent("touchmove", {
          touches: [touch], targetTouches: [touch], changedTouches: [touch],
          bubbles: true, cancelable: true,
        }));
      }
      return { duringBurst: window.__hits.count };
    }, burstWord.x, burstWord.y);
    // Two frames, because the work is scheduled from inside the first one.
    const afterFrames = await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.__hits.count)));
    }));
    await touchEnd();
    await wait(300);
    check(burst.duringBurst === 0,
      "thirty touchmoves in one frame do no hit-testing between them",
      `${burst.duringBurst} hit-tests during the burst`);
    // caretInRoot() tries up to four points when the direct hit-test lands in a
    // block's padding, so one extend is not always one call — but it is never
    // thirty.
    check(afterFrames >= 1 && afterFrames <= 4,
      "...and exactly one extend runs on the frame after them",
      `${afterFrames} hit-tests once the frame came round`);
    const burstResult = await page.evaluate(() => window.__selection());
    check(Boolean(burstResult) && burstResult.length > 5,
      "...and the drag still arrives where it was aimed",
      burstResult ? `${burstResult.length} chars, ending in ${burstResult.endMarker}` : "selection lost");

    // ── 15. One description per selection ──────────────────────────────────
    //
    // One finished selection reached positionNotesSelectionButton three times —
    // endDrag(), the pointerup settle 45ms later, and the trailing
    // selectionchange on the 300ms debounce — and each pass threw the pill's
    // capture away and ran it again: three clones of the fragment, two Turndown
    // conversions and an occurrence count over the note above the selection,
    // three times, in the first third of a second after the finger lifted. That
    // is the hitch as the bar arrives.
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await wait(200);
    await page.evaluate(() => window.__reveal("P0078"));
    await wait(250);
    const captureWord = await page.evaluate(() => window.__wordRect("P0078", 2));
    await page.evaluate(() => { window.__captures.count = 0; });
    await touchStart(captureWord.x, captureWord.y);
    await wait(700);
    await touchEnd();
    // Well past all three call-ins: 45ms settle, 300ms debounce.
    await wait(900);
    const captures = await page.evaluate(() => ({
      count: window.__captures.count,
      hidden: document.getElementById("selectionFloat").hidden,
      title: document.getElementById("makeCardFromSelectionBtn").title,
    }));
    check(captures.count === 1,
      "one finished selection is described once, not once per call-in",
      `${captures.count} capture${captures.count === 1 ? "" : "s"}`);
    check(!captures.hidden && /word/.test(captures.title),
      "...and the pill is up, describing it",
      `hidden: ${captures.hidden}, title: "${captures.title}"`);

    // ── 16. None of this exists on a desktop ───────────────────────────────
    //
    // The fence, asserted rather than asserted-about. Emulation off, reload, and
    // every trace of the controller must be gone: no class, no overlay, no
    // registered highlight, and the reading surface selectable again by the
    // browser's own machinery.
    await page.call("Emulation.clearDeviceMetricsOverride");
    await page.call("Emulation.setTouchEmulationEnabled", { enabled: false });
    if (THROTTLE > 1) await page.call("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "desktop boot" });
    await wait(1500);
    const desktop = await page.evaluate(() => ({
      media: window.matchMedia("(pointer: coarse) and (hover: none)").matches,
      touchPoints: navigator.maxTouchPoints,
      armed: document.body.classList.contains("has-touch-select"),
      overlay: Boolean(document.querySelector(".touch-select-layer")),
      registered: Boolean(window.CSS && window.CSS.highlights && window.CSS.highlights.has("recall-touch-selection")),
      userSelect: getComputedStyle(document.getElementById("notesView")).webkitUserSelect,
    }));
    check(!desktop.media || desktop.touchPoints === 0,
      "a desktop does not satisfy the gate",
      `media: ${desktop.media}, maxTouchPoints: ${desktop.touchPoints}`);
    check(!desktop.armed, "...so the controller never armed", `has-touch-select: ${desktop.armed}`);
    check(!desktop.overlay, "...no handle overlay was built", `overlay: ${desktop.overlay}`);
    check(!desktop.registered, "...no highlight was registered", `registered: ${desktop.registered}`);
    check(desktop.userSelect === "text",
      "...and the notes are still selectable by the browser itself", `user-select: ${desktop.userSelect}`);

    // A real mouse drag on that same desktop still selects. Proving the
    // controller is ABSENT is not the same as proving the path it replaced still
    // works, and the second one is what a desktop reader actually cares about.
    const desktopSetup = await page.evaluate(new Function(`return (${SETUP_SRC})`)(), API_SRC);
    if (desktopSetup && desktopSetup.paragraphs >= 40) {
      const from = await page.evaluate(() => window.__wordRect("P0003", 1));
      const to = await page.evaluate(() => window.__wordRect("P0003", 6));
      const mouse = (type, x, y) => page.call("Input.dispatchMouseEvent", {
        type, x, y, button: "left", buttons: type === "mouseMoved" ? 1 : (type === "mouseReleased" ? 0 : 1),
        clickCount: 1,
      });
      await mouse("mousePressed", from.left + 1, from.y);
      for (let i = 1; i <= 6; i += 1) {
        await mouse("mouseMoved", from.left + ((to.right - from.left) * i) / 6, from.y);
        await wait(20);
      }
      await mouse("mouseReleased", to.right, to.y);
      await wait(400);
      const mouseSel = await page.evaluate(() => ({
        // Selection.toString() is the RIGHT reader here, and using it is part of
        // the assertion: it is only empty over user-select: none, and this page
        // has none.
        text: (window.getSelection() || "").toString(),
        pillHidden: document.getElementById("selectionFloat").hidden,
      }));
      check(mouseSel.text.includes(from.word) && mouseSel.text.includes(to.word),
        "a mouse drag on a desktop still selects the words it crossed",
        `"${mouseSel.text.slice(0, 48)}"`);
      check(mouseSel.pillHidden === false,
        "...and the pill still appears for it", `hidden: ${mouseSel.pillHidden}`);
    } else {
      fail("the desktop fixture rendered", desktopSetup ? `${desktopSetup.paragraphs} paragraphs` : "missing");
    }

    check(errors.length === 0, "no uncaught exceptions", errors.length ? errors[0] : "clean");
  } finally {
    if (browser) browser.close();
    server.proc.kill();
  }

  console.log(failures ? `\n${failures} problem(s)` : "\nall good");
  return failures ? 1 : 0;
}

run().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
