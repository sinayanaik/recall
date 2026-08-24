// Is the picture on screen, and can you still reach its controls?
//
//   node tools/image-render-check.mjs
//
// tools/image-controls-check.mjs answers the question one layer down: does the
// SOURCE SCAN find exactly the images marked renders, and does acting on one
// rewrite only its own slice. Every function it exercises is a pure function of
// a string, which is why it needs no browser — and why it could not see any of
// what this file is about. Three of the four reports that led here are facts
// about layout and input, and none of them is visible from a string:
//
//   1. "The image is not visible." Every upload path writes ![](url) with an
//      EMPTY alt and #notesView .diagram-shell img:not(.has-custom-size) forces
//      width:auto, so an <img> whose source cannot be fetched paints NOTHING.
//      Measured here rather than argued: the element computes to 0x0 and its
//      shell collapses to about 82x50 — an empty rounded box holding only the
//      "Zoom" pill, which is exactly the screenshot that opened the report.
//   2. "The resize buttons are not visible." Inside a box that small the grip,
//      the delete button and the pill are painted on top of each other. Three
//      rectangles, asserted not to intersect.
//   3. "Sometimes the delete button doesn't work." Chrome marks touchmove
//      non-cancelable once it has committed to scrolling, which latches
//      gestureStolen in the touch controller — and the tap that follows took an
//      early return that never cleared it, so onRootTouchEnd preventDefault()ed
//      the compatibility mouse sequence and no click was ever synthesised.
//      Driven here the way tools/touch-selection-check.mjs drives it, by
//      shadowing event.cancelable on one move.
//
// Plus the two source-level fixes, asserted END TO END rather than against the
// scanner alone: an image written after a stray ``` in a sentence, and one
// whose URL carries parentheses, both keep their controls.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A host that refuses the connection immediately, so a "this image is dead"
// case costs a failed TCP handshake rather than a timeout.
const DEAD_IMAGE = "http://127.0.0.1:1/gone.png";

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
    "/src/images/surface-controls.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/render/block-cache.js?v=__BUILD__",
    "/src/cards/card-view.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// The app, signed in against a stand-in backend, with one note open. The stub
// implements only what the image path touches, and deliberately has no
// getPublicUrl: with no canonical storage prefix, resolveStorageImages and
// deleteSupabaseImage both no-op, so nothing here reaches a network.
const SETUP_SRC = `async (apiSrc, dead) => {
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
    from: () => { throw new Error("image-render-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Image fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  // ── The fixture ──────────────────────────────────────────────────────────
  // Four images, each answering one question, each with an id in its alt text
  // so an assertion can name which picture it is talking about.
  //
  //   dead    a reference that cannot load: the placeholder and the controls
  //   afterFence  written after a bare \\\`\\\`\\\` in a SENTENCE, which used to open a
  //           fence and swallow everything to the next marker
  //   parens  a URL carrying parentheses, which the old token stopped at
  //   inFence a real fenced code block holding image markdown — text, not a
  //           picture, and nothing may offer a control over it
  window.__fixture = [
    "# Images",
    "",
    "![dead](" + dead + ")",
    "",
    "Wrap it in \\\`\\\`\\\` fences when you want code.",
    "",
    "![afterFence](" + dead + "?a=1)",
    "",
    "![parens](" + dead + "?b=Foo_(bar))",
    "",
    "\\\`\\\`\\\`js",
    "const s = \\"![inFence](" + dead + "?c=1)\\";",
    "\\\`\\\`\\\`",
    ""
  ].join("\\n");
  api.state.notes = window.__fixture;
  api.renderNotesView();
  await settle(1200);

  // ── Reading one image's world back ───────────────────────────────────────
  // The shell, its three controls and whether any pair of them overlaps. Every
  // number is a real rect off the real stylesheets.
  window.__shellFor = (alt) => {
    const img = Array.from(document.querySelectorAll("#notesView img"))
      .find((n) => n.getAttribute("alt") === alt);
    if (!img) return null;
    const shell = img.closest(".diagram-shell");
    if (!shell) return { hasShell: false };
    const box = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const grip = box(shell.querySelector(".notes-img-resize-handle"));
    const del = box(shell.querySelector(".notes-img-delete-btn"));
    const zoom = box(shell.querySelector(".diagram-zoom"));
    const overlaps = (a, b) => Boolean(a && b)
      && !(a.right <= b.x || a.x >= b.right || a.bottom <= b.y || a.y >= b.bottom);
    return {
      hasShell: true,
      broken: shell.classList.contains("has-broken-image"),
      label: shell.dataset.brokenLabel || "",
      editable: shell.classList.contains("is-editable-image"),
      shell: box(shell),
      image: box(img),
      grip, del, zoom,
      // The pill is hidden on a broken image (nothing to open full screen), so
      // "no overlap" is asked of whichever of the three are actually painted.
      overlapping: [[grip, del], [grip, zoom], [del, zoom]].filter(([a, b]) => overlaps(a, b)).length
    };
  };

  // The centre of one image's delete button, for a real tap.
  window.__deletePoint = (alt) => {
    const b = window.__shellFor(alt);
    if (!b || !b.del) return null;
    return { x: b.del.x + b.del.w / 2, y: b.del.y + b.del.h / 2 };
  };

  // ── One touchmove the browser has taken ─────────────────────────────────
  // Chrome decides this in the compositor and CDP cannot synthesise it, so it
  // is shadowed on the event exactly as tools/touch-selection-check.mjs does.
  // The controller reads event.cancelable and nothing else.
  window.__steal = 0;
  document.getElementById("notesView").addEventListener("touchmove", (event) => {
    if (!window.__steal) return;
    window.__steal -= 1;
    Object.defineProperty(event, "cancelable", { value: false, configurable: true });
  }, { capture: true });

  const view = document.getElementById("notesView");
  return {
    // Reported so a fixture that never became visible fails HERE, loudly,
    // instead of turning every rect below into a meaningless 0.
    width: view.clientWidth,
    images: view.querySelectorAll("img").length,
    shells: view.querySelectorAll(".diagram-shell").length
  };
}`;

// ── ...and the same questions of a BOOK ────────────────────────────────────
//
// Everything above is a note small enough to render in one go. A note over
// NOTES_LAZY_MIN_CHARS (200,000 characters — i.e. every imported book) is built
// span by span as the reader moves through it, and three things that work on a
// small note did not work there at all:
//
//   • an image the book uses TWICE was skipped outright while any span was
//     unbuilt, deferred to "the pass that runs when the last span lands" — a
//     pass that only runs once the reader has scrolled the whole book, so in
//     practice that picture had a Zoom pill and nothing else, forever;
//   • every diagram was skipped for the same reason, and unconditionally: the
//     whole diagram pass was gated on the note being complete;
//   • a URL carrying a non-ASCII character never matched at all, on any note,
//     because marked percent-encodes an image destination and the scan of the
//     markdown does not.
//
// The fixture is deliberately built and then NOT scrolled: every assertion
// below is about what a reader sees on opening a book, which is the state the
// report came from.
const BOOK_SETUP_SRC = `async (dead) => {
  const { api, settle } = window.__recall;
  // 2,400 paragraphs: past NOTES_LAZY_MIN_CHARS *and* past NOTES_LAZY_MIN_SPANS,
  // which is counted in blocks (NOTES_CHUNK_MIN_BLOCKS / NOTES_LAZY_SPAN_SEGMENTS)
  // rather than characters. A note that clears one and not the other renders
  // eagerly and would make all of this vacuous.
  const filler = (n) => Array.from({ length: n }, (_, i) =>
    "Paragraph " + i + " of the fixture, long enough to carry its own weight in the span plan and then some more words after that.").join("\\n\\n");
  const dup = dead + "?dup=1";
  window.__book = [
    "# A book",
    "",
    "![twice](" + dup + ")",
    "",
    // Written with the character in it, NOT pre-encoded: marked runs encodeURI
    // over the destination and the markdown does not, and that difference is
    // the whole reason imageMatchKey exists. A fixture that hands over an
    // already-encoded URL asserts nothing.
    "![u](" + dead + "?name=\\u00dcber.png)",
    "",
    "\\u0060\\u0060\\u0060mermaid",
    "graph TD; A-->B;",
    "\\u0060\\u0060\\u0060",
    "",
    filler(2400),
    "",
    "![twice](" + dup + ")",
    ""
  ].join("\\n");
  api.state.notes = window.__book;
  api.renderNotesView();
  await settle(1800);
  const view = document.getElementById("notesView");
  const diagram = view.querySelector(".mermaid, .nomnoml-diagram");
  return {
    chars: window.__book.length,
    // The whole point of the fixture: it must still be holding spans back.
    pending: api.notesLazyPending(view),
    spans: api.notesLazyPlan(view) ? api.notesLazyPlan(view).spans.length : 0,
    shells: view.querySelectorAll(".diagram-shell").length,
    diagramGrip: Boolean(diagram && diagram.parentElement
      && diagram.parentElement.querySelector(".notes-img-resize-handle"))
  };
}`;

// One card face, which no check has ever covered — #questionView is a
// first-class image surface (IMAGE_SURFACE_NAMES) and a regression there would
// have passed silently.
const CARD_SETUP_SRC = `async (dead) => {
  const { api, settle } = window.__recall;
  const card = { id: "fixture-card", question: "![cardq](" + dead + "?card=1)", answer: "plain" };
  api.state.masterCards = [card];
  api.state.cards = [card];
  api.state.current = 0;
  await api.showCard();
  await settle(600);
  const shell = document.querySelector("#questionView .diagram-shell");
  return {
    shell: Boolean(shell),
    grip: Boolean(shell && shell.querySelector(".notes-img-resize-handle")),
    del: Boolean(shell && shell.querySelector(".notes-img-delete-btn")),
    editable: Boolean(shell && shell.classList.contains("is-editable-image"))
  };
}`;

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("image-render-check: no Chrome on this machine — skipping.");
    return 0;
  }

  const server = await serveOn(ROOT);
  let browser = null;
  const errors = [];
  try {
    browser = await launchChrome(chrome);
    const client = await connect(browser.wsUrl);
    const page = await openPage(client);
    await emulatePhone(page, { width: 390, height: 844 });
    await page.call("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*"] });
    client.on((message) => {
      if (message.sessionId !== page.sessionId) return;
      if (message.method === "Runtime.exceptionThrown") {
        errors.push(message.params?.exceptionDetails?.exception?.description
          || message.params?.exceptionDetails?.text || "unknown");
      }
    });

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "boot" });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      console.log("image-render-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await wait(2000);

    const setup = await page.evaluate(
      new Function("apiSrc", "dead", `return (${SETUP_SRC})(apiSrc, dead);`),
      API_SRC, DEAD_IMAGE
    );

    // Three pictures, and the fourth is inside a fence and must not be one.
    if (!setup || !setup.width) {
      console.log(`image-render-check: the notes view never became visible (${JSON.stringify(setup)}) — nothing below would mean anything.`);
      return 1;
    }
    check(setup.images === 3, "the fixture renders its three images",
      `${setup.images} <img>, ${setup.shells} shells, view ${setup.width}px`);

    // ── 1. A picture that cannot load is still something you can see ────────
    const dead = await page.evaluate(() => window.__shellFor("dead"));
    check(Boolean(dead && dead.hasShell), "the dead image has a shell", dead ? "yes" : "missing");
    check(Boolean(dead && dead.broken), "...marked broken",
      dead ? `class ${dead.broken}` : "n/a");
    check(Boolean(dead && dead.label), "...and labelled with which picture it was",
      dead ? JSON.stringify(dead.label) : "n/a");
    check(Boolean(dead && dead.shell && dead.shell.w >= 176 && dead.shell.h >= 124),
      "...at a size a reader can actually see",
      dead && dead.shell ? `${Math.round(dead.shell.w)}x${Math.round(dead.shell.h)}` : "n/a");

    // ── 2. ...and whose controls are not on top of each other ───────────────
    check(Boolean(dead && dead.grip), "the dead image keeps its resize grip", dead && dead.grip ? "present" : "missing");
    check(Boolean(dead && dead.del), "...and its delete button", dead && dead.del ? "present" : "missing");
    check(dead && dead.overlapping === 0, "...with no two controls overlapping",
      dead ? `${dead.overlapping} overlapping pair(s)` : "n/a");

    // ── The two source-level fixes, end to end ──────────────────────────────
    const afterFence = await page.evaluate(() => window.__shellFor("afterFence"));
    check(Boolean(afterFence && afterFence.grip && afterFence.del),
      "an image after a bare ``` in a sentence keeps its controls",
      afterFence ? `grip ${Boolean(afterFence.grip)}, delete ${Boolean(afterFence.del)}` : "not rendered");

    const parens = await page.evaluate(() => window.__shellFor("parens"));
    check(Boolean(parens && parens.grip && parens.del),
      "an image whose URL carries parentheses keeps its controls",
      parens ? `grip ${Boolean(parens.grip)}, delete ${Boolean(parens.del)}` : "not rendered");

    const inFence = await page.evaluate(() => window.__shellFor("inFence"));
    check(inFence === null, "image markdown inside a fenced code block is text, not a picture",
      inFence === null ? "no <img>" : "rendered as an image");

    // ── 3. Scroll, then tap the delete button ───────────────────────────────
    //
    // The scroll is what latches gestureStolen: one non-cancelable touchmove is
    // the compositor saying the sequence is its own now. The tap that follows
    // is a real trusted touch through the browser's own input pipeline, so the
    // click it does or does not synthesise is the browser's answer, not ours.
    await page.evaluate(() => { window.__steal = 3; });
    const scrollFrom = await page.evaluate(() => {
      const view = document.getElementById("notesView");
      const r = view.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.call("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: scrollFrom.x, y: scrollFrom.y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
    });
    for (let i = 1; i <= 3; i += 1) {
      await page.call("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: scrollFrom.x, y: scrollFrom.y - i * 24, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
      });
      await wait(24);
    }
    await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await wait(200);

    const point = await page.evaluate(() => window.__deletePoint("dead"));
    if (!point) {
      fail("the delete button is somewhere to tap", "no button");
    } else {
      const before = await page.evaluate(() => window.__recall.api.state.notes);
      await page.tap(point.x, point.y);
      await wait(700);
      const after = await page.evaluate(() => window.__recall.api.state.notes);
      check(before !== after && !after.includes("![dead]"),
        "a tap on 🗑 right after a scroll removes the image",
        before === after ? "the note did not change" : "removed");
      // ...and took nothing else with it.
      check(after.includes("![afterFence]") && after.includes("![parens]") && after.includes("![inFence]"),
        "...and leaves every other image where it was",
        `${(after.match(/!\[/g) || []).length} image references left`);
    }

    // ── The controls survive a re-bind ──────────────────────────────────────
    //
    // enhanceSurfaceImageControls runs on the tail of every render, on every
    // lazily built span and on every placeholder-upgrade batch. It used to
    // REMOVE and rebuild the grip and the delete button each time, so a pass
    // landing between a finger going down on the button and the click it would
    // have produced took that button out of the DOM. Identity, not appearance,
    // is the assertion.
    const rebind = await page.evaluate(() => {
      const { api } = window.__recall;
      const shell = document.querySelector("#notesView .diagram-shell");
      if (!shell) return null;
      const before = shell.querySelector(".notes-img-delete-btn");
      const surface = api.imageSurfaceFor("notes");
      api.enhanceSurfaceImageControls(surface);
      api.enhanceSurfaceImageControls(surface);
      const after = shell.querySelector(".notes-img-delete-btn");
      return { same: Boolean(before) && before === after, present: Boolean(after) };
    });
    check(Boolean(rebind && rebind.same), "two more enhance passes keep the same delete button",
      rebind ? `present ${rebind.present}, same node ${rebind.same}` : "no shell");

    // ── A book, opened and not scrolled ─────────────────────────────────────
    const book = await page.evaluate(new Function("dead", `return (${BOOK_SETUP_SRC})(dead);`), DEAD_IMAGE);
    if (!book || !book.pending) {
      fail("the book fixture is built lazily",
        book ? `${book.chars} chars, ${book.spans} spans, pending ${book.pending}` : "no answer");
    } else {
      ok("the book fixture is built lazily", `${book.chars} chars, ${book.spans} spans, spans still pending`);
      const twice = await page.evaluate(() => window.__shellFor("twice"));
      check(Boolean(twice && twice.grip && twice.del),
        "an image the book uses twice keeps its controls without reading to the end",
        twice ? `grip ${Boolean(twice.grip)}, delete ${Boolean(twice.del)}` : "not rendered");
      const unicode = await page.evaluate(() => window.__shellFor("u"));
      check(Boolean(unicode && unicode.grip && unicode.del),
        "an image whose URL carries a non-ASCII character keeps its controls",
        unicode ? `grip ${Boolean(unicode.grip)}, delete ${Boolean(unicode.del)}` : "not rendered");
      check(book.diagramGrip, "a diagram in a half-built book keeps its resize grip",
        book.diagramGrip ? "present" : "missing");
    }

    // ── ...and a card face, which is an image surface too ───────────────────
    const card = await page.evaluate(new Function("dead", `return (${CARD_SETUP_SRC})(dead);`), DEAD_IMAGE);
    check(Boolean(card && card.shell), "a card's question renders its image in a shell",
      card && card.shell ? "yes" : "no shell");
    check(Boolean(card && card.grip && card.del && card.editable),
      "...and the card face gets the same grip and delete button the notes do",
      card ? `grip ${Boolean(card.grip)}, delete ${Boolean(card.del)}, editable ${Boolean(card.editable)}` : "n/a");

    check(errors.length === 0, "no uncaught exceptions", errors.length ? errors[0] : "clean");
  } finally {
    if (browser) browser.proc.kill();
    server.proc.kill();
  }

  console.log(failures ? `\n${failures} problem(s)` : "\nall good");
  return failures ? 1 : 0;
}

run().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
