// Does a note stay where the reader is — and reopen where they left it?
//
//   node tools/reading-position-check.mjs
//
// "Im seeing incorrect last location sync, randomly I'm going to some place and
// then randomly to some other place."
//
// Several paths move #notesView on the reader's behalf: the resume that lands a
// reopened deck, the jumps a reader asks for, a sync that rewrites the note
// under them, and the corrections that chase layout while a long note settles.
// Each case below is one way two of those used to disagree, driven through the
// real modules on an emulated phone and asserted as CONTENT (the paragraph on
// the reading line), never as a scroll offset — the same rule
// tools/interaction-scale-check.mjs's resume case explains.
//
//   1. A sync that changes the note does not throw the reader to the top, and
//      does not write "the top" down as their position.
//   2. A finger on the glass ends a jump's corrections; it is not pulled back.
//   3. A position still waiting to be written for one deck survives opening
//      the next one within its two-second debounce.
//   4. A jump the reader asked for is not overtaken by a resume still landing.
//   5. A deck reopened on Cards is not dragged onto Notes to land its position
//      — and the position is landed when the reader does go to Notes.
//   6. Nothing captured while a resume is landing is taken for the reader's
//      position.
//   7. "Go to bookmark" lets go the moment the reader scrolls away — even when
//      its words cannot be found, which is when it used to keep pulling them
//      back for eight seconds.
//   8. A bookmark taken on a paragraph full of markdown and inline HTML (what
//      an imported book is made of) is found again word for word.
//   9. A resume the reader interrupts still reports itself settled, which is
//      what arms the bookmark for the file that was opened.
//  10. A folder opened as one document — how a book imported one file per
//      chapter is read — reopens where it was left, not at its first page.
//  11. Presses before a resume has landed (the app bar, a toast, the note
//      while it is still rendering) do not leave a book at its contents.
//  12. A bookmark newer than this device's place is where the file reopens —
//      a PDF page in meta.readingPosition never wins it — with no "Jump
//      there?" question.
//  13. A sync during the landing neither captures the top as the bookmark nor
//      pins the reader back to it.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let ran = 0;
function ok(name, detail = "") {
  console.log(`ok   ${name}${detail ? `  [${detail}]` : ""}`);
}
function fail(name, detail) {
  failures += 1;
  console.log(`FAIL ${name}${detail ? `  [${detail}]` : ""}`);
}
function check(condition, name, detail) {
  ran += 1;
  if (condition) ok(name, detail);
  else fail(name, detail);
}

// Two paragraph markers within a paragraph of each other. A captured offset
// can sit on the blank line that ends the paragraph above the reading line.
function near(a, b, tolerance = 1) {
  const n = (m) => (/^P\d{4}$/.test(m || "") ? Number(m.slice(1)) : NaN);
  return Math.abs(n(a) - n(b)) <= tolerance;
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

const SETUP_SRC = `async () => {
  const paths = [
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/notes/anchors.js?v=__BUILD__",
    "/src/notes/scroll-anchor.js?v=__BUILD__",
    "/src/notes/reading-position.js?v=__BUILD__",
    "/src/notes/bookmark.js?v=__BUILD__",
    "/src/library/folder-deck.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/notes/raw-offset.js?v=__BUILD__",
    "/src/storage/deck-snapshot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/ui/overlays.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  const scrollAnchor = mods[paths.indexOf("/src/notes/scroll-anchor.js?v=__BUILD__")];
  api.readingAnchorNow = () => scrollAnchor.currentReadingAnchor;
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("reading-position-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Reading position fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");
  const lines = ["# Position probe", ""];
  // Every tenth paragraph is written the way an imported book is: emphasis, a
  // footnote marker and a link, none of which reads the same rendered. Its
  // words are its own, as a book's are — a sentence repeated paragraph after
  // paragraph would let any search take the wrong copy.
  for (let i = 0; i < 160; i += 1) {
    const marker = "P" + String(i).padStart(4, "0");
    const own = words.map((w) => w + i);
    const body = i % 10 === 5
      ? own.slice(0, 4).join(" ") + " **" + own[4] + "** " + own[5] + "<sup>3</sup> " + own[6]
        + " [" + own[7] + "](https://example.com/" + i + ") _" + own[8] + "_ " + own.slice(9).join(" ")
        + " " + own.join(" ") + " " + own.slice(0, 8).join(" ")
      : words.join(" ") + " " + words.join(" ");
    lines.push(marker + " " + body + ".", "");
  }
  api.state.notes = lines.join("\\n");
  api.renderNotesView();
  await settle(800);

  const view = document.getElementById("notesView");
  // The paragraph on the reading line, by its marker.
  window.__reading = () => {
    const block = api.notesBlockAtReadingLineGeometric();
    return block ? (block.textContent || "").trim().slice(0, 5) : "";
  };
  // Put a paragraph on the reading line the way a reader scrolling would.
  window.__scrollTo = (marker) => {
    const target = Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith(marker));
    if (!target) return false;
    const delta = target.getBoundingClientRect().top - view.getBoundingClientRect().top;
    view.scrollTop = Math.max(0, view.scrollTop + delta - 8);
    view.dispatchEvent(new Event("scroll"));
    return true;
  };
  // The paragraph a stored offset falls in, by its marker.
  window.__markerAt = (offset) => {
    const notes = api.state.notes;
    const at = notes.lastIndexOf("\\nP", offset);
    return at < 0 ? notes.slice(0, 5) : notes.slice(at + 1, at + 6);
  };
  // The anchor a capture would take for a paragraph, without scrolling there.
  window.__anchorFor = (marker) => {
    const notes = api.state.notes;
    const offset = notes.indexOf(marker);
    return { offset, text: notes.slice(offset, offset + 80), source: notes.slice(offset, offset + 80), at: Date.now() };
  };
  return { paragraphs: view.querySelectorAll("p").length };
}`;

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("reading-position-check: no Chrome on this machine — skipping.");
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
    const touchTap = async (x, y) => {
      await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }] });
      await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };

    await page.goto(`${server.base}/index.html`);
    await page.waitFor(() => !document.documentElement.classList.contains("app-booting"),
      { timeout: 60000, label: "boot" });
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
      console.log("reading-position-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await wait(1500);
    const setup = await page.evaluate(new Function(`return (${SETUP_SRC})`)());
    if (!setup || setup.paragraphs < 100) {
      console.log(`reading-position-check: the fixture is ${setup ? `${setup.paragraphs} paragraphs` : "missing"} — nothing below would mean anything`);
      return 1;
    }
    ok("the fixture rendered", `${setup.paragraphs} paragraphs`);

    // ── 1. A sync rewrites the note under the reader ────────────────────────
    //
    // Exactly what loadDeckFromLibrary({ keepPlace: true }) does when a sync
    // brings in a highlight made on another device: loadDeckSnapshot with
    // keepPlace, then the deckReloadedInPlace hook's renderNotesViewPinned.
    // A deck with an identity, as every library deck has: the position store is
    // keyed by it, and an unsaved working deck's key changes the moment the
    // autosave gives it a local id.
    await page.evaluate(() => {
      window.__recall.api.state.localDeckId = "fixture-local";
      window.__scrollTo("P0080");
    });
    await wait(2600);
    const beforeSync = await page.evaluate(() => {
      const { api } = window.__recall;
      api.flushReadingPositionSave();
      const stored = api.readStoredReadingPosition(api.currentDeckKey());
      const memory = api.readingAnchorNow();
      return {
        reading: window.__reading(),
        scrollTop: document.getElementById("notesView").scrollTop,
        stored: stored ? window.__markerAt(stored.offset) : null,
        memory: memory ? window.__markerAt(memory.offset) : null,
        key: api.currentDeckKey(),
      };
    });
    await page.evaluate(() => {
      const { api } = window.__recall;
      const payload = api.deckSnapshot();
      payload.notes = payload.notes.replace("P0010 alpha", "P0010 <mark>alpha</mark>");
      api.loadDeckSnapshot(payload, "", false, { keepPlace: true });
      // loadDeckFromLibrary's next line, and then its deckReloadedInPlace hook.
      api.state.localDeckId = "fixture-local";
      api.renderNotesViewPinned();
    });
    await wait(2800);
    const afterSync = await page.evaluate(() => {
      const { api } = window.__recall;
      api.flushReadingPositionSave();
      const stored = api.readStoredReadingPosition(api.currentDeckKey());
      return {
        reading: window.__reading(),
        scrollTop: document.getElementById("notesView").scrollTop,
        stored: stored ? window.__markerAt(stored.offset) : null,
        key: api.currentDeckKey(),
      };
    });
    check(beforeSync.reading === "P0080" && near(beforeSync.stored, "P0080"),
      "reading well into the note before the sync, and that is the stored position",
      `on ${beforeSync.reading}, stored at ${beforeSync.stored}, in memory ${beforeSync.memory}, key ${beforeSync.key}`);
    check(afterSync.reading === beforeSync.reading,
      "a sync that changes the note leaves the reader where they were",
      `${beforeSync.reading} -> ${afterSync.reading} (scrollTop ${Math.round(beforeSync.scrollTop)} -> ${Math.round(afterSync.scrollTop)})`);
    check(near(afterSync.stored, beforeSync.reading),
      "...and their stored position is still that paragraph, not the top of the note",
      `stored position is at ${JSON.stringify(afterSync.stored)} (key ${afterSync.key})`);

    // ── 2. A finger ends a jump's corrections ────────────────────────────────
    //
    // convergeNotesScroll re-aims every ~110ms for 1.2s while a long note
    // settles. The residual here keeps shrinking, so without the reader's input
    // it would keep correcting for the whole budget.
    const convergence = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      const view = document.getElementById("notesView");
      view.scrollTop = 400;
      await settle(100);
      let left = 900;
      const residual = () => { left = Math.max(0, left - 60); return left; };
      const running = api.convergeNotesScroll(residual, 1200, { smooth: false });
      await settle(260);
      return { started: view.scrollTop, running: Boolean(running) };
    });
    const touchAt = await page.evaluate(() => {
      const r = document.getElementById("notesView").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await touchTap(touchAt.x, touchAt.y);
    const atTouch = await page.evaluate(() => document.getElementById("notesView").scrollTop);
    await wait(1100);
    const afterTouch = await page.evaluate(() => document.getElementById("notesView").scrollTop);
    check(convergence.started > 400, "the corrections were running", `scrollTop 400 -> ${Math.round(convergence.started)}`);
    check(Math.abs(afterTouch - atTouch) < 1,
      "a finger on the glass ends them — the note is not pulled back under it",
      `${Math.round(atTouch)} at the touch, ${Math.round(afterTouch)} a second later`);

    // ── 3. Two decks inside one debounce ────────────────────────────────────
    const twoDecks = await page.evaluate(() => {
      const { api } = window.__recall;
      const keyA = JSON.stringify(["deck-a", "local-a", null]);
      const keyB = JSON.stringify(["deck-b", "local-b", null]);
      const anchorA = { offset: 1234, text: "deck A's last place", at: Date.now() };
      const anchorB = { offset: 5, text: "deck B's first capture", at: Date.now() + 1 };
      api.scheduleReadingPositionSave(keyA, anchorA);
      api.scheduleReadingPositionSave(keyB, anchorB);
      api.flushReadingPositionSave();
      return {
        a: api.readStoredReadingPosition(keyA)?.offset ?? null,
        b: api.readStoredReadingPosition(keyB)?.offset ?? null,
      };
    });
    check(twoDecks.a === 1234 && twoDecks.b === 5,
      "a position still waiting for one deck survives opening the next",
      `deck A: ${twoDecks.a}, deck B: ${twoDecks.b}`);

    // ── 4. A jump the reader asked for, while a resume is still landing ────
    await page.evaluate(() => {
      const { api } = window.__recall;
      const view = document.getElementById("notesView");
      view.scrollTop = 0;
      api.scheduleNoteJump(window.__anchorFor("P0140"), { flash: false, smooth: false, resume: true });
      api.scheduleNoteJump(window.__anchorFor("P0030"), { flash: false, smooth: false });
    });
    await wait(3200);
    const afterJump = await page.evaluate(() => window.__reading());
    const jumpNear = /^P00(2[6-9]|3[0-4])$/.test(afterJump);
    check(jumpNear,
      "a jump the reader asked for is not overtaken by a resume still landing",
      `asked for P0030, reading ${afterJump}`);

    // ── 5. A deck reopened on Cards ─────────────────────────────────────────
    const cardsFirst = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("cards");
      await settle(300);
      api.setNotesScrolledSource(null);
      api.resumeOpenedDeck(window.__anchorFor("P0120"));
      await settle(600);
      const stayed = api.state.viewMode;
      api.setViewMode("notes");
      await settle(3000);
      return { stayed, reading: window.__reading() };
    });
    check(cardsFirst.stayed === "cards",
      "a deck reopened on Cards stays on Cards — its notes position does not drag it to Notes",
      `view: ${cardsFirst.stayed}`);
    check(/^P01(1[6-9]|2[0-4])$/.test(cardsFirst.reading),
      "...and going to Notes lands that position there",
      `expected ~P0120, reading ${cardsFirst.reading}`);

    // ── 6. Captures while a resume is landing ───────────────────────────────
    //
    // The deck-open sequence: the new note opens at its top, the resume lands.
    // The top is not a place anyone read; it must not end up as the position.
    const landing = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("cards");
      await settle(200);
      // Where the reader got to, as the store holds it — exactly what the deck
      // loaders resume from.
      api.writeStoredReadingPosition(api.currentDeckKey(), window.__anchorFor("P0100"));
      api.setNotesScrolledSource(null);
      api.setViewMode("notes");
      api.resumeOpenedDeck(api.betterReadingPosition(null, api.currentDeckKey()));
      await settle(3600);
      api.flushReadingPositionSave();
      const stored = api.readStoredReadingPosition(api.currentDeckKey());
      const inMemory = api.readingAnchorNow();
      const at = (a) => (a ? window.__markerAt(a.offset) : null);
      return { reading: window.__reading(), stored: at(stored), memory: at(inMemory) };
    });
    check(/^P0(09[6-9]|10[0-4])$/.test(landing.reading), "the resume landed", `reading ${landing.reading}`);
    check(near(landing.stored, "P0100") && (landing.memory == null || near(landing.memory, "P0100", 4)),
      "...and the note's top, passed through on the way, was not recorded as the position",
      `stored: ${JSON.stringify(landing.stored)}, in memory: ${JSON.stringify(landing.memory)}`);

    // ── 7. Go to bookmark, then scroll somewhere else ───────────────────────
    //
    // A bookmark as the old capture took it: a slice of the raw markdown, which
    // on this paragraph never appears in the rendered text. The jump can only
    // land on the block, and it used to re-aim there every 600ms for its whole
    // eight-second budget — under the reader's finger.
    const jumped = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      const view = document.getElementById("notesView");
      view.scrollTop = 0;
      await settle(300);
      api.state.meta = { ...(api.state.meta || {}), bookmark: window.__anchorFor("P0055") };
      api.goToBookmark();
      await settle(1500);
      return { reading: window.__reading() };
    });
    check(near(jumped.reading, "P0055", 2), "go to bookmark lands on the bookmarked paragraph", `reading ${jumped.reading}`);
    await touchTap(touchAt.x, touchAt.y);
    const scrolledAway = await page.evaluate(() => {
      const view = document.getElementById("notesView");
      view.scrollTop += 3000;
      view.dispatchEvent(new Event("scroll"));
      return { scrollTop: view.scrollTop, reading: window.__reading() };
    });
    await wait(2500);
    const afterAway = await page.evaluate(() => ({
      scrollTop: document.getElementById("notesView").scrollTop,
      reading: window.__reading(),
      status: document.getElementById("statusText")?.textContent || ""
    }));
    check(Math.abs(afterAway.scrollTop - scrolledAway.scrollTop) < 2 && afterAway.reading === scrolledAway.reading,
      "...and scrolling away is not pulled back to it",
      `${Math.round(scrolledAway.scrollTop)} (${scrolledAway.reading}) after the finger, ${Math.round(afterAway.scrollTop)} (${afterAway.reading}) 2.5s later`);
    check(!/Couldn't find that spot/.test(afterAway.status),
      "...and no 'couldn't find that spot' once the reader has moved on",
      afterAway.status || "no status");

    // ── 8. A bookmark taken in an imported book's markup ────────────────────
    const exact = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      const view = document.getElementById("notesView");
      window.__scrollTo("P0065");
      await settle(400);
      const anchor = api.currentSpotAnchor();
      view.scrollTop = 0;
      await settle(300);
      window.getSelection()?.removeAllRanges();
      api.state.meta = { ...(api.state.meta || {}), bookmark: anchor };
      api.goToBookmark();
      // Inside the flash's 1.8s: the block flash is only drawn when the exact
      // words were found (revealRenderedNoteRange), never by the estimate.
      await settle(900);
      return {
        text: anchor?.text || "",
        reading: window.__reading(),
        flashed: Boolean(document.querySelector("#notesView .note-anchor-flash"))
      };
    });
    check(exact.text && !/[*_<>\[\]]/.test(exact.text),
      "a bookmark's words are the words on screen, not the markdown behind them",
      JSON.stringify(exact.text.slice(0, 60)));
    check(exact.flashed && exact.reading === "P0065",
      "...so going back finds them exactly, and puts them back on the reading line",
      `reading ${exact.reading}, ${exact.flashed ? "flashed" : "not flashed (fell back to an estimate)"}`);

    // ── 9. A resume the reader interrupts ───────────────────────────────────
    await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("notes");
      await settle(300);
      window.__settledBy = null;
      api.resumeOpenedDeck(window.__anchorFor("P0150"), () => { window.__settledBy = "resume"; });
    });
    await touchTap(touchAt.x, touchAt.y);
    await wait(1200);
    const interrupted = await page.evaluate(() => window.__settledBy);
    check(interrupted === "resume",
      "a resume the reader interrupts still settles, so the file's bookmark is armed",
      `onSettled ${interrupted ? "called" : "never called"}`);

    // ── 11. Touches while a resume waits for the note to render ────────────
    //
    // A file opened on a big book shows its first screen while the note is
    // still rendering, and the resume used to end on the first press anywhere
    // — the app bar, a toast, the note itself — leaving the book at its
    // contents. Until the resume has put the reader somewhere, none of that is
    // the reader choosing a place.
    const waited = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("cards");
      await settle(200);
      api.setNotesScrolledSource(null);
      api.setViewMode("notes");
      const rendering = api.isNotesRenderInFlight();
      api.resumeOpenedDeck(window.__anchorFor("P0130"));
      const press = (node) => node && node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch" }));
      press(document.querySelector(".appbar"));
      press(document.getElementById("notesView"));
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      // What is on screen while it waits: the loader, not a blank note.
      const loader = document.querySelector(".notes-resume-loader:not(.is-leaving)");
      const waiting = {
        loader: Boolean(loader) && document.getElementById("notesView").classList.contains("is-resuming"),
        where: loader?.querySelector(".notes-resume-where")?.textContent || "",
        through: loader?.querySelector(".notes-resume-through")?.textContent || "",
        inNote: Boolean(loader && document.getElementById("notesView").contains(loader))
      };
      await settle(3000);
      return {
        rendering,
        waiting,
        reading: window.__reading(),
        hidden: document.getElementById("notesView").classList.contains("is-resuming"),
        loaderGone: !document.querySelector(".notes-resume-loader")
      };
    });
    check(waited.rendering, "the note was still rendering when the resume began", String(waited.rendering));
    check(near(waited.reading, "P0130", 3),
      "presses before the resume has landed do not leave the file at its top",
      `expected ~P0130, reading ${waited.reading}`);
    check(!waited.hidden, "...and the note is visible again once it has landed", waited.hidden ? "still hidden" : "visible");
    check(waited.waiting.loader && !waited.waiting.inNote && /Position probe/.test(waited.waiting.where) && /% through$/.test(waited.waiting.through),
      "while it waits, a loader says where the reader is being taken instead of a blank note",
      JSON.stringify(waited.waiting));
    check(waited.loaderGone, "...and the loader is gone once the resume has landed", waited.loaderGone ? "gone" : "still there");

    // ── 12. The bookmark is newer than the reading position ─────────────────
    //
    // The sync captures the bookmark on every run, so it is often the newest
    // place there is — and the PDF writes meta.readingPosition too. The file
    // reopens on the newest Notes place, and asks nothing.
    const newest = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      const key = api.currentDeckKey();
      const now = Date.now();
      api.writeStoredReadingPosition(key, { ...window.__anchorFor("P0020"), at: now - 60000 });
      const meta = {
        ...(api.state.meta || {}),
        bookmark: { ...window.__anchorFor("P0110"), at: now - 1000 },
        readingPosition: { offset: 3, pdfPage: 3, ratio: 0.2, text: "Page 3", at: now }
      };
      api.state.meta = meta;
      const chosen = api.resumePositionForOpen(meta, key);
      api.setViewMode("cards");
      await settle(200);
      api.setNotesScrolledSource(null);
      api.setViewMode("notes");
      let settledCalled = false;
      api.resumeOpenedDeck(chosen, () => { settledCalled = true; api.bookmarkResumeSettled(); });
      await settle(3000);
      return {
        chosen: chosen ? window.__markerAt(chosen.offset) : null,
        reading: window.__reading(),
        settledCalled,
        modal: !document.getElementById("confirmModal")?.hidden
      };
    });
    check(newest.chosen === "P0110",
      "a bookmark newer than this device's place is where the file reopens, and a PDF page never wins it",
      `chose ${newest.chosen}`);
    check(near(newest.reading, "P0110", 3) && newest.settledCalled,
      "...and the Notes land there", `reading ${newest.reading}`);
    check(!newest.modal, "...with no \"Jump there?\" question", newest.modal ? "a confirm dialog is open" : "no dialog");

    // ── 13. A sync while a resume is landing ────────────────────────────────
    const syncDuring = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("cards");
      await settle(200);
      api.setNotesScrolledSource(null);
      api.setViewMode("notes");
      api.resumeOpenedDeck(window.__anchorFor("P0090"));
      // The capture a sync starts with, and the repaint it ends with.
      const captured = api.captureBookmarkForSync();
      api.renderNotesViewPinned();
      await settle(3200);
      return { captured, reading: window.__reading() };
    });
    check(!syncDuring.captured, "a sync's bookmark capture writes nothing while the resume is landing", String(syncDuring.captured));
    check(near(syncDuring.reading, "P0090", 3),
      "...and its repaint does not pin the reader back to where the note opened",
      `expected ~P0090, reading ${syncDuring.reading}`);

    // ── 14. Start from the top, instead of waiting ──────────────────────────
    //
    // The loader's button. The resume stops for good — nothing pulls the note
    // to the old place afterwards — it still settles, so the file's bookmark
    // capture is armed, and the reader is at the top of the note.
    const fromTop = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("cards");
      await settle(200);
      api.setNotesScrolledSource(null);
      api.setViewMode("notes");
      let settledCalled = false;
      api.resumeOpenedDeck(window.__anchorFor("P0140"), () => { settledCalled = true; });
      const button = document.querySelector(".notes-resume-loader .notes-resume-top");
      button?.click();
      await settle(3000);
      return {
        button: Boolean(button),
        reading: window.__reading(),
        settledCalled,
        hidden: document.getElementById("notesView").classList.contains("is-resuming"),
        loaderGone: !document.querySelector(".notes-resume-loader")
      };
    });
    check(fromTop.button, "the loader offers Start from the top", fromTop.button ? "offered" : "no button");
    check(near(fromTop.reading, "P0000", 3) && !fromTop.hidden && fromTop.loaderGone,
      "...which leaves the reader at the top, with the note shown and the loader gone",
      `reading ${fromTop.reading}, ${fromTop.hidden ? "hidden" : "shown"}, loader ${fromTop.loaderGone ? "gone" : "still there"}`);
    check(fromTop.settledCalled, "...and still settles the resume, so the bookmark is armed", String(fromTop.settledCalled));

    // ── 10. A book read as its chapter folder ───────────────────────────────
    const folder = await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      const view = document.getElementById("notesView");
      const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ");
      const ids = [];
      for (let c = 0; c < 3; c += 1) {
        api.createNewDeck({ title: "Chapter " + (c + 1), notesMode: true });
        await settle(200);
        api.commitNotesEditIfActive();
        // A file of its own: case 1 pinned a local id onto the working deck by
        // hand, and a save would otherwise write every chapter over that one.
        api.state.localDeckId = null;
        api.state.deckId = null;
        api.state.deckCategory = "Fixture book";
        const lines = ["# Chapter " + (c + 1), ""];
        for (let i = 0; i < 50; i += 1) {
          lines.push("C" + c + "P" + String(i).padStart(3, "0") + " " + words.map((w) => w + c + "x" + i).join(" ") + " " + words.join(" ") + ".", "");
        }
        api.state.notes = lines.join("\n");
        await api.saveDeckToLibrary({ silent: true });
        await settle(150);
        ids.push(api.state.localDeckId);
      }
      const open = () => api.openDecksAsOneDeck(
        ids.map((localId, i) => ({ sel: { localId }, title: "Chapter " + (i + 1), category: "Fixture book" })),
        { title: "Fixture book", path: "Fixture book", key: api.folderDeckKey("Fixture book"), landOn: "notes", onEmpty: "refuse" }
      );
      const reading = () => (api.notesBlockAtReadingLineGeometric()?.textContent || "").trim().slice(0, 6);
      if (!(await open())) return { opened: false };
      await settle(1500);
      const target = Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith("C1P030"));
      if (!target) return { opened: true, found: false, ids };
      view.scrollTop = Math.max(0, view.scrollTop + target.getBoundingClientRect().top - view.getBoundingClientRect().top - 8);
      view.dispatchEvent(new Event("scroll"));
      await settle(1200);
      const left = reading();
      api.flushReadingPositionSave();
      // Somewhere else with a note of its own, so the view really is repainted
      // and scrolled for it — as opening any other file, or a cold start, does.
      await api.loadDeckFromLibrary(ids[0]);
      await settle(1500);
      const between = reading();
      await open();
      await settle(3000);
      return { opened: true, found: true, left, between, back: reading(), key: api.currentDeckKey() };
    });
    check(folder.opened && folder.found && folder.left === "C1P030",
      "a chapter folder opened as one document, and read into its middle",
      JSON.stringify(folder));
    check(folder.back === folder.left,
      "...reopens where it was left, not at its first page",
      `left on ${folder.left}, reopened on ${folder.back}`);

    check(errors.length === 0, "no uncaught exceptions", errors.length ? errors[0] : "clean");
  } finally {
    if (browser) browser.close();
    server.proc.kill();
  }

  console.log(failures ? `\n${failures} problem(s)` : "\nall good");
  console.log(`CHECK: ${ran} checks · ${failures} failed`);
  return failures ? 1 : 0;
}

run().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(1);
});
