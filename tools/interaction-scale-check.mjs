// Is the app still ANSWERING once a book-sized note is on screen?
//
//   node tools/interaction-scale-check.mjs
//
// tools/render-scale-check.mjs proves a big note APPEARS quickly. This one
// proves that afterwards you can still use the app, which is a different
// question and was not covered anywhere: reported as "when a large file is
// loaded the app UI becomes very very much laggy — I click the app menu button
// and it opens after 5 seconds", plus a long press that would not start a
// selection, a TOC that stopped following the reader, and a reading position
// that was neither saved nor resumed.
//
// Every case here is one user action taken against a 2.6MB, ~24,000-block note.
// Measured on a desktop with no CPU throttling, which is the point: a phone is
// several times slower again, and these were the numbers when this was written:
//
//   ☰ pressed while the book opens   ???ms  <- the press waits behind whatever
//                                              the renderer is already doing
//   describing a selection           218ms  <- cloneContents() of the entire
//                                              note above the selection
//   the tail after the render        258ms  <- marked.lexer over the whole note
//                                              plus a full TOC rebuild
//   TOC active row, paged mode       wrong  <- lit "Chapter 60" while reading
//                                              chapter 37, on every book
//   reading position             not saved  <- only ever written as a side
//                                              effect of some other save
//   resuming it                 492,621px   <- i.e. not at all
//
// The highlight case was 314ms and is 249ms; it is here because it is the
// reading gesture that pays for everything at once, and because what is left of
// it is one known thing — see the note on `highlightMs`.
//
// Long-press selection itself cannot be tested here — it is browser UI and
// headless Chrome does not implement it (see the note in render-scale-check).
// What is measurable, and is the actual cause, is how long the main thread
// stops answering around the events a long press delivers.

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
  for (const base of [ROOT, "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/"]) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}
const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) { console.log("interaction-scale-check: no puppeteer/Chrome — skipping."); process.exit(0); }

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

// Budgets. Deliberately generous — these are "the app answers a finger", not
// "the app is fast": a frame is 16ms and the numbers this replaced were in the
// hundreds of milliseconds. A regression that matters will blow through them.
const BUDGET = {
  busyTapMs: 200,    // how long a press may wait for the main thread, mid-render
  selectionMs: 40,   // describing a live selection two thirds down the note
  occurrenceMs: 250, // ...and then asking which copy of the text it is
  // The worst frame gap while a highlight is applied and saved. Set above
  // today's measured 249ms rather than at some ideal: an edit re-runs
  // preprocessSpecialBlocks and marked.lexer over the WHOLE note (11ms + 113ms
  // on this fixture) before it can diff a single block, and splitting the lexer
  // incrementally is a real piece of work that has not been done. The budget is
  // where the cost actually is, so a regression still shows up here.
  highlightMs: 350,
  tailMs: 200,       // longest blocking task in the second after the render
  resumeMs: 6000     // how long a resumed reading position may take to land
};

// Stage 1: sign in, open a notes deck, and leave everything the later stages
// need on window.__recall. Split out of the probe because the one thing that
// cannot be measured from inside the page is how long the page takes to ANSWER
// an event — that has to be driven from Node, with the renderer busy.
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
    from: () => { throw new Error("interaction-scale-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Interaction fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  // A book. Same shape as render-scale-check's largest fixture (about 2.6MB and
  // ~24,000 top-level blocks, so well past NOTES_CHUNK_MIN_BLOCKS), with unique
  // text so no cached block can be reused.
  const out = [];
  for (let c = 0; c < 60; c += 1) {
    out.push("# Chapter " + (c + 1) + "\\n");
    for (let s = 0; s < 100; s += 1) {
      out.push("## Section " + (c + 1) + "." + (s + 1) + "\\n");
      out.push("Interaction paragraph " + (s + 1) + " of chapter " + (c + 1) + ". " +
        "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(3) + "\\n");
      out.push("- bullet one\\n- bullet two\\n- bullet three\\n");
    }
  }
  window.__recall.md = out.join("\\n");

  const view = document.getElementById("notesView");
  return { width: view ? view.clientWidth : 0, height: view ? view.clientHeight : 0, chars: window.__recall.md.length };
}`;

// Stage 2: start the cold render of the book and return immediately, so the tap
// driven from Node lands while the renderer is doing exactly what it does when
// a reader opens a book and reaches straight for a control.
const START_RENDER_SRC = `() => {
  const R = window.__recall;
  const api = R.api;
  api.state.notes = R.md;
  api.setNotesScrolledSource(null);
  api.invalidateRenderedBlockCache();
  R.longest = 0;
  R.longestAfter = 0;
  R.renderDoneAt = 0;
  R.renderDone = false;
  try {
    R.observer = new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => {
        R.longest = Math.max(R.longest, e.duration);
        if (R.renderDoneAt && e.startTime >= R.renderDoneAt) R.longestAfter = Math.max(R.longestAfter, e.duration);
      });
    });
    R.observer.observe({ entryTypes: ["longtask"] });
  } catch (_) { R.observer = null; }
  api.renderNotesView().then(() => { R.renderDoneAt = performance.now(); R.renderDone = true; });
  return true;
}`;

// Stage 3: everything that can honestly be measured from inside the page.
const PROBE = `async (budget, tapCases) => {
  const R = window.__recall;
  const api = R.api;
  const state = api.state;
  const md = R.md;
  const settle = R.settle;
  const results = tapCases.slice();
  const push = (name, detail, measured) => results.push({
    name,
    ok: detail === true,
    detail: detail === true ? "" : String(detail),
    measured: measured == null ? "" : String(measured)
  });

  const view = document.getElementById("notesView");

  // ── The tail that lands after the render ─────────────────────────────────
  //
  // Measured separately from the render itself because it is a separate user
  // experience: the render is allowed to be busy (the reader is watching a book
  // open), while the tail lands when the reader believes the app is idle and is
  // already reaching for a control.
  await settle(1500);
  const longest = R.longest;
  const longestAfter = R.longestAfter;
  const blocks = api.notesTopLevelBlocks(view);
  push("the fixture is big enough to be chunked", (() => {
    if (blocks.length < 2000) return "only " + blocks.length + " blocks — the chunked branch is not exercised";
    if (!view.querySelector(":scope > .notes-chunk")) return "no .notes-chunk wrappers";
    return true;
  })());

  push("nothing blocks the main thread after the note has rendered", (() => {
    if (longest <= 0) return true; // no longtask support in this build
    if (longestAfter > budget.tailMs) return "a " + Math.round(longestAfter) + "ms task ran after the render resolved";
    return true;
  })(), "longest task after the render " + Math.round(longestAfter) + "ms (during it " + Math.round(longest) + "ms)");

  // ── Describing a selection ──────────────────────────────────────────────
  //
  // Two thirds down the note on purpose: the cost this measures was
  // proportional to how much of the note sits ABOVE the selection, so a
  // selection near the top passes on a build where reading a book is unusable.
  {
    const textNode = (() => {
      // Walk forward from two thirds down until a block with real prose in it
      // turns up — the block at any given fraction is as likely to be a heading
      // or a three-item list as a paragraph.
      const from = Math.floor(blocks.length * 0.66);
      for (let i = from; i < Math.min(blocks.length, from + 40); i += 1) {
        const walker = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT);
        let node = null;
        while ((node = walker.nextNode())) if ((node.data || "").trim().length > 40) return node;
      }
      return null;
    })();
    if (!textNode) {
      push("a selection can be made two thirds down the note", "found no text node to select");
    } else {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(20, textNode.data.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      await settle(60);
      const started = performance.now();
      const described = api.renderedSelectionStrings(view);
      const took = performance.now() - started;
      push("describing a selection does not walk the whole note", took > budget.selectionMs
        ? "renderedSelectionStrings took " + Math.round(took) + "ms"
        : true, Math.round(took) + "ms");

      // Reading the occurrence count is a separate measurement because it is
      // now a separate moment: the pill's ACTIONS need it, the act of selecting
      // does not. It still has to be affordable — this is what a press pays.
      const countStarted = performance.now();
      const occurrence = described ? described.occurrence : null;
      const countTook = performance.now() - countStarted;
      push("counting which copy was selected stays affordable", countTook > budget.occurrenceMs
        ? "reading .occurrence took " + Math.round(countTook) + "ms"
        : true, Math.round(countTook) + "ms");

      // The description still has to be right — this is the number every
      // highlight/cloze/erase resolves its position against.
      push("the description is still correct", (() => {
        if (!described) return "renderedSelectionStrings returned null";
        if (!described.asText) return "no asText";
        if (!Number.isFinite(occurrence)) return "occurrence is " + occurrence;
        const slice = textNode.data.slice(0, Math.min(20, textNode.data.length)).trim();
        if (slice && described.asText.indexOf(slice.slice(0, 8)) === -1) {
          return "asText " + JSON.stringify(described.asText.slice(0, 40)) + " does not contain the selected text";
        }
        return true;
      })());
      selection.removeAllRanges();
      await settle(60);
    }
  }

  // ── The occurrence count is the SAME number it always was ────────────────
  //
  // The count moved from "clone everything above the selection and search the
  // string" to "walk to the selection and count as you go". Highlight, cloze,
  // erase and a card's note anchor all resolve which copy of a repeated phrase
  // they act on from this number, so an equivalent-but-different answer would
  // be a silent correctness regression, not a performance one.
  //
  // Checked near the TOP of the note on purpose: the old method has to be run
  // here too, and it is only affordable when there is little above it. Run over
  // a list, where the walk's block/cell/gap rules actually do something.
  {
    const at = Math.floor(blocks.length * 0.05);
    const cases = [];
    for (let i = at; i < Math.min(blocks.length, at + 12); i += 1) {
      const walker = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT);
      let node = null;
      while ((node = walker.nextNode())) if ((node.data || "").trim().length > 4) cases.push(node);
    }
    let mismatched = "";
    let checked = 0;
    for (const node of cases.slice(0, 8)) {
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.max(1, Math.min(30, node.data.length)));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const described = api.renderedSelectionStrings(view);
      if (!described || !described.asText) continue;
      // The old implementation, verbatim.
      const pre = document.createRange();
      pre.setStart(view, 0);
      pre.setEnd(range.startContainer, range.startOffset);
      const wasCount = api.countOccurrences(api.textWithLineBreaks(pre.cloneContents()), described.asText);
      checked += 1;
      if (described.occurrence !== wasCount && !mismatched) {
        mismatched = JSON.stringify(described.asText.slice(0, 30)) + ": counted " + described.occurrence + ", was " + wasCount;
      }
      selection.removeAllRanges();
    }
    push("the occurrence count matches the walk it replaced", (() => {
      if (!checked) return "no selections could be made to compare";
      if (mismatched) return mismatched;
      return true;
    })(), checked + " selections compared");
  }

  // ── Highlighting a sentence in a book ───────────────────────────────────
  //
  // The core reading gesture in this app, and the one that pays for everything
  // else at once: it rewrites the note, repaints it (renderNotesViewPinned),
  // runs the render tail again, and arms an autosave that serialises the whole
  // deck. On a 2.6MB note every one of those is proportional to the book rather
  // than to the sentence, which is what "the app gets laggy once a big note is
  // loaded" describes — the app is not idle between highlights, it is still
  // finishing the last one.
  {
    // Forward from halfway until a paragraph turns up — the block at any given
    // fraction is as likely to be a heading or a three-item list.
    const textNode = (() => {
      const from = Math.floor(blocks.length * 0.5);
      for (let i = from; i < Math.min(blocks.length, from + 40); i += 1) {
        const walker = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT);
        let node = null;
        while ((node = walker.nextNode())) if ((node.data || "").trim().length > 40) return node;
      }
      return null;
    })();
    if (!textNode) {
      push("highlighting a sentence does not block the app", "found no sentence to highlight");
    } else {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(40, textNode.data.length));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      await settle(80);
      const before = state.notes.length;
      let worst = 0;
      let last = performance.now();
      let beating = true;
      const beat = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        if (beating) requestAnimationFrame(beat);
      };
      requestAnimationFrame(beat);
      await settle(120);
      last = performance.now();
      worst = 0;
      api.makeHighlightFromSelection(api.renderTargetConfig("notes"), "yellow");
      // Past the autosave debounce (400ms) and the repaint it triggers.
      await settle(2500);
      beating = false;
      push("highlighting a sentence marks it", state.notes.length > before
        ? true
        : "the note did not gain a <mark>");
      push("highlighting a sentence does not block the app", worst > budget.highlightMs
        ? "the page could not answer for " + Math.round(worst) + "ms while the highlight landed"
        : true, "worst frame gap " + Math.round(worst) + "ms");
      state.notes = md;
      await api.renderNotesView();
      await settle(300);
    }
  }

  // ── The TOC's active row ────────────────────────────────────────────────
  {
    api.openNotesToc();
    await settle(400);
    const headings = api.ensureNotesHeadingIds();
    const wanted = headings[Math.floor(headings.length * 0.5)];
    push("the TOC drawer built a list", (() => {
      const links = document.querySelectorAll("#notesTocList .notes-toc-link");
      if (!links.length) return "no .notes-toc-link rows";
      if (links.length !== headings.length) return links.length + " rows for " + headings.length + " headings";
      return true;
    })());
    // Put the wanted heading on the reading line by hand rather than through
    // the TOC jump, so this measures the SCROLL-SPY and not the jump.
    api.withChunkRendered(wanted, view, () => {
      const delta = wanted.getBoundingClientRect().top - view.getBoundingClientRect().top;
      view.scrollTop = Math.max(0, view.scrollTop + delta - 8);
    });
    await settle(500);
    api.updateNotesTocActive();
    await settle(120);
    push("the TOC's active row is the section being read", (() => {
      const active = document.querySelector("#notesTocList .notes-toc-link.is-active");
      if (!active) return "no row is active";
      const want = (wanted.textContent || "").trim();
      const got = (active.querySelector(".notes-toc-text")?.textContent || "").trim();
      if (got !== want) return "active row is " + JSON.stringify(got) + ", reading " + JSON.stringify(want);
      return true;
    })());
    // ── A repaint with the drawer open ────────────────────────────────────
    //
    // The list is rebuilt after every render, and a rebuild forgets which row
    // was lit. Highlighting a sentence while the contents are open therefore
    // left the drawer with nothing active until the reader scrolled again,
    // which is what "the TOC does not reliably update" describes.
    state.notes = md.replace("Interaction paragraph 1 of chapter 1.", "Interaction paragraph 1 of chapter 1 <mark>edited</mark>.");
    await api.renderNotesViewPinned();
    await settle(700);
    push("the TOC survives a repaint with the drawer open", (() => {
      const links = document.querySelectorAll("#notesTocList .notes-toc-link");
      if (links.length !== headings.length) return links.length + " rows for " + headings.length + " headings after a repaint";
      const active = document.querySelector("#notesTocList .notes-toc-link.is-active");
      if (!active) return "no row is active after a repaint";
      const want = (wanted.textContent || "").trim();
      const got = (active.querySelector(".notes-toc-text")?.textContent || "").trim();
      if (got !== want) return "active row is " + JSON.stringify(got) + " after a repaint, reading " + JSON.stringify(want);
      return true;
    })());
    state.notes = md;
    await api.renderNotesViewPinned();
    await settle(400);

    api.closeNotesToc();
    await settle(200);
  }

  // ── The same question in paged (book) mode ───────────────────────────────
  //
  // Paged mode lays out ONE chapter and hides the rest with display:none, so
  // every heading outside the active chapter has no box at all, and
  // notesPageForElement
  // answers 0 for those, and "page <= current page" is TRUE for a heading in a
  // chapter the reader has not reached — so the scroll-spy's binary search ran
  // off the end of the book and lit the last heading in it, on every note with
  // more than one chapter.
  {
    api.setNotesReadingMode("paged-1");
    await settle(1500);
    if (!api.isNotesPaged()) {
      push("paged reading mode engages on a book", "isNotesPaged() is false after setNotesReadingMode('paged-1')");
    } else {
      push("paged reading mode engages on a book", true);
      api.openNotesToc();
      await settle(400);
      const headings = api.ensureNotesHeadingIds();
      const wanted = headings[Math.floor(headings.length * 0.6)];
      api.scrollNotesHeadingIntoView(wanted);
      await settle(1600);
      api.updateNotesTocActive();
      await settle(200);
      push("the TOC's active row follows the reader in paged mode", (() => {
        const active = document.querySelector("#notesTocList .notes-toc-link.is-active");
        if (!active) return "no row is active";
        const want = (wanted.textContent || "").trim();
        const got = (active.querySelector(".notes-toc-text")?.textContent || "").trim();
        if (got !== want) return "active row is " + JSON.stringify(got) + ", reading " + JSON.stringify(want);
        return true;
      })());
      api.closeNotesToc();
    }
    api.setNotesReadingMode("continuous");
    await settle(1200);
    view.scrollTop = 0;
    await settle(200);
  }

  // ── Saving and resuming the reading position ────────────────────────────
  //
  // Reading a note and touching nothing else must be enough. The old code only
  // ever wrote the position when some OTHER save happened, so a reader who
  // never edits lost their place on every reload.
  //
  // "Where you were" is asserted as CONTENT, not as a scroll offset. A long
  // note's height is mostly estimates until the reader has been there, so the
  // same paragraph legitimately sits at a different scrollTop before and after
  // a fresh render — comparing pixels tests the layout, not the feature.
  {
    const readingLineText = () => {
      const block = api.notesBlockAtReadingLineGeometric();
      return block ? (block.textContent || "").trim().slice(0, 60) : "";
    };
    const target = blocks[Math.floor(blocks.length * 0.4)];
    api.withChunkRendered(target, view, () => {
      const delta = target.getBoundingClientRect().top - view.getBoundingClientRect().top;
      view.scrollTop = Math.max(0, view.scrollTop + delta - 8);
    });
    view.dispatchEvent(new Event("scroll"));
    // Long enough for the capture debounce, its idle callback and the
    // persistence debounce on top of it.
    await settle(3000);
    const wasReading = readingLineText();

    push("reading the note captured a position", (() => {
      const anchor = api.readingAnchorNow();
      if (!anchor) return "nothing captured in memory";
      if (!Number.isFinite(anchor.offset)) return "captured offset is " + anchor.offset;
      return true;
    })());

    const stored = api.storedReadingPosition ? api.storedReadingPosition() : null;
    push("the position was persisted without editing anything", stored && Number.isFinite(stored.offset)
      ? true
      : "nothing on disk for this deck (" + JSON.stringify(stored) + ")");

    // Reopen: a cold render of the same note, then the ambient resume.
    const resumeFrom = stored || api.readingAnchorNow();
    if (!resumeFrom || !wasReading) {
      push("the note reopens where it was left", !wasReading ? "could not tell what was being read" : "no position to resume from");
    } else {
      api.setNotesScrolledSource(null);
      api.invalidateRenderedBlockCache();
      view.scrollTop = 0;
      await api.renderNotesView();
      api.scheduleNoteJump(resumeFrom, { flash: false, smooth: false, resume: true });
      // The resume is allowed to take its time on a book — it has to wait for
      // the stream and for chunk heights to settle — but it must land.
      let waited = 0;
      while (waited < 6000 && readingLineText() !== wasReading) {
        await settle(250);
        waited += 250;
      }
      const nowReading = readingLineText();
      push("the note reopens where it was left", nowReading === wasReading
        ? true
        : "reopened on " + JSON.stringify(nowReading) + ", was reading " + JSON.stringify(wasReading),
        "landed after " + waited + "ms");
    }
  }

  // ── ...on a note whose blocks are NOT all the same size ─────────────────
  //
  // The fixture above is a grid: every paragraph the same length, so its
  // content-visibility height estimates are proportional to how much SOURCE
  // each block holds, and "40% down the pixels" happens to be "40% through the
  // markdown". A real book is not like that — short dialogue lines and long
  // descriptive paragraphs estimate to the same height and hold twenty times
  // the text — and the resume's search window used to be built in pixel space
  // while its aim was built in source space. On the grid the two agreed and
  // every case above passed; on a book they disagreed by up to 2,564 BLOCKS,
  // the search found nothing, and the resume warned "Reading position not found
  // in the rendered note" every single time.
  //
  // So the uniform fixture cannot see this entire class of bug, and this case
  // exists because it did not: it went red on the commit before the fix and
  // green after, with nothing else changed.
  {
    const varied = [];
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const WORDS = ("time person year way day thing man world life hand part child eye woman place work week case " +
      "government company number group problem fact hound moor lantern carriage window letter shadow silence " +
      "morning evening question answer footstep candle drawer envelope railway platform whisper").split(" ");
    const sentences = (n) => {
      const parts = [];
      for (let i = 0; i < n; i += 1) {
        const words = [];
        const len = 8 + Math.floor(rnd() * 12);
        for (let w = 0; w < len; w += 1) words.push(WORDS[Math.floor(rnd() * WORDS.length)]);
        // A unique token per sentence, the way real prose carries names and
        // numbers. Without it the snippet matching is ambiguous by construction
        // and this case would be measuring the fixture, not the app.
        words.splice(2, 0, "tok" + (seed % 100000).toString(36) + i);
        parts.push(words.join(" ") + ".");
      }
      return parts.join(" ");
    };
    for (let c = 0; c < 30; c += 1) {
      varied.push("# Chapter " + (c + 1) + "\\n");
      for (let sec = 0; sec < 60; sec += 1) {
        varied.push("## Section " + (c + 1) + "." + (sec + 1) + "\\n");
        // The whole point: block length varies by ~20x, and the long ones are
        // clustered in the back half, so estimated height stops tracking source
        // position the way the grid made it.
        const long = ((c * 60 + sec) % 7) === 0 ? 20 : (c > 15 ? 5 : 1);
        varied.push("Varied paragraph " + (sec + 1) + " of chapter " + (c + 1) + ". " + sentences(long * 3) + "\\n");
        varied.push(long === 1 ? "\\"A short line.\\" said nobody.\\n" : "- " + sentences(1) + "\\n- " + sentences(1) + "\\n");
      }
    }
    state.notes = varied.join("\\n");
    api.setNotesScrolledSource(null);
    api.invalidateRenderedBlockCache();
    view.scrollTop = 0;
    await api.renderNotesView();
    await settle(1500);

    const lineText = () => {
      const b = api.notesBlockAtReadingLineGeometric();
      return b ? (b.textContent || "").trim().slice(0, 60) : "";
    };
    const vBlocks = api.notesTopLevelBlocks(view);
    const target = vBlocks[Math.floor(vBlocks.length * 0.4)];
    api.withChunkRendered(target, view, () => {
      const delta = target.getBoundingClientRect().top - view.getBoundingClientRect().top;
      view.scrollTop = Math.max(0, view.scrollTop + delta - 8);
    });
    view.dispatchEvent(new Event("scroll"));
    await settle(3000);
    const wasReading = lineText();
    const anchor = api.readingAnchorNow();

    // Any "not found" the resume reports is a failure of this case, whatever
    // the note ends up looking like — that warning IS the reported bug.
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => { warnings.push(a.map(String).join(" ")); realWarn(...a); };

    api.setNotesScrolledSource(null);
    api.invalidateRenderedBlockCache();
    view.scrollTop = 0;
    await api.renderNotesView();
    api.scheduleNoteJump(anchor, { flash: false, smooth: false, resume: true });
    let waited = 0;
    while (waited < budget.resumeMs && lineText() !== wasReading) {
      await settle(250);
      waited += 250;
    }
    // The full resume budget, so a loop that gives up late still reports here.
    await settle(Math.max(0, 9000 - waited));
    console.warn = realWarn;

    push("a book with uneven blocks reopens where it was left", !wasReading || !anchor
      ? "could not tell what was being read"
      : lineText() === wasReading
        ? true
        : "reopened on " + JSON.stringify(lineText()) + ", was reading " + JSON.stringify(wasReading),
      "landed after " + waited + "ms");
    push("the resume does not report a position it could not find", warnings.length === 0
      ? true
      : warnings.length + " warning(s): " + warnings[0]);
  }

  R.observer?.disconnect();
  return results;
}`;

const API_SRC = `async () => {
  const paths = [
    "/src/render/block-cache.js?v=__BUILD__",
    "/src/render/preprocess.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/notes/toc.js?v=__BUILD__",
    "/src/notes/paged-view.js?v=__BUILD__",
    "/src/notes/anchors.js?v=__BUILD__",
    "/src/notes/scroll-anchor.js?v=__BUILD__",
    "/src/format/locate-selection.js?v=__BUILD__",
    "/src/format/highlight.js?v=__BUILD__",
    "/src/format/render-toolbar.js?v=__BUILD__",
    "/src/notes/selection.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  // Live reads. Copying the keys above snapshots every binding, and the two
  // things this check has to watch CHANGE after that copy.
  const scrollAnchor = mods[paths.indexOf("/src/notes/scroll-anchor.js?v=__BUILD__")];
  api.readingAnchorNow = () => scrollAnchor.currentReadingAnchor;
  // Persistence lives in its own module and may not exist yet on an older
  // build — the case that needs it says so rather than throwing.
  try {
    const rp = await import("/src/notes/reading-position.js?v=__BUILD__");
    api.storedReadingPosition = () => rp.readStoredReadingPosition(api.currentDeckKey());
    api.flushStoredReadingPosition = () => rp.flushReadingPositionSave();
  } catch (_) { api.storedReadingPosition = null; }
  return api;
}`;

async function attempt(base, errors, budget) {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=390,844"]
  });
  try {
    const page = await browser.newPage();
    // A phone, because that is where this was reported and where the main
    // thread has the least to spare.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
    for (const lib of [
      "recall-clipper/vendor/marked.min.js", "recall-clipper/vendor/purify.min.js",
      "recall-clipper/vendor/katex/katex.min.js", "recall-clipper/vendor/katex/auto-render.min.js"
    ]) {
      const full = path.join(ROOT, lib);
      if (existsSync(full)) await page.evaluateOnNewDocument(readFileSync(full, "utf8"));
    }
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 })
      .catch(() => {});
    if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) return null;
    await new Promise((r) => setTimeout(r, 2500));

    const setup = await page.evaluate(
      async (setupSrc, apiSrc) => (0, eval)("(" + setupSrc + ")")(apiSrc),
      SETUP_SRC, API_SRC
    );
    if (!setup || setup.width < 200 || setup.height < 200) {
      return [{ name: "setup", ok: false, detail: `#notesView is ${setup ? setup.width + "x" + setup.height : "missing"} — nothing below would mean anything` }];
    }

    // ── Tapping the app menu while the book is opening ─────────────────────
    //
    // Driven from here, through the real input pipeline, because that is the
    // reported experience: "I click the app menu button and it opens after 5
    // seconds". A synthesised dispatchEvent inside the page cannot show this at
    // all — it runs the handler synchronously and so measures the handler, not
    // the wait. What a reader feels is the event sitting in a queue behind
    // whatever the main thread is already doing, and then the handler.
    const tapCases = [];
    // A window-level capture listener, so it runs BEFORE every handler the app
    // registers. `timeStamp` on a trusted event is when the browser generated
    // it, so `now - timeStamp` at the top of the capture phase is exactly how
    // long the press sat waiting for the main thread — which is the thing the
    // reader is complaining about, and the only part of the wall clock below
    // that belongs to the app rather than to the debugging protocol.
    await page.evaluate(() => {
      window.__tap = null;
      window.addEventListener("pointerdown", (e) => {
        if (!window.__tap) window.__tap = { waited: performance.now() - e.timeStamp };
      }, { capture: true, once: false });
    });
    await page.evaluate((src) => (0, eval)("(" + src + ")")(), START_RENDER_SRC);
    const tapStarted = Date.now();
    try {
      await page.click("#mobileMenuBtn");
      await page.waitForFunction(
        () => document.getElementById("mainToolbar")?.classList.contains("mobile-open"),
        { timeout: 20000, polling: "raf" }
      );
      const wallMs = Date.now() - tapStarted;
      const waited = await page.evaluate(() => (window.__tap ? Math.round(window.__tap.waited) : -1));
      tapCases.push({
        name: "the app menu answers a press while a book is still opening",
        ok: waited >= 0 && waited <= budget.busyTapMs,
        detail: waited < 0
          ? "the press was never delivered"
          : `the press waited ${waited}ms for the main thread`,
        measured: `waited ${waited}ms (${wallMs}ms wall clock, protocol overhead included)`
      });
    } catch (e) {
      tapCases.push({
        name: "the app menu answers a press while a book is still opening",
        ok: false,
        detail: `the drawer never opened (${String(e.message).split("\n")[0]})`,
        measured: ""
      });
    }
    // Close it again, or every later case runs under an open drawer.
    await page.evaluate(() => document.getElementById("toolbarCloseBtn")?.click());

    // The render is still going; wait it out before the rest of the cases.
    await page.waitForFunction(() => window.__recall.renderDone === true, { timeout: 120000, polling: 200 });

    return await page.evaluate(
      async (probeSrc, budgetIn, tapIn) => (0, eval)("(" + probeSrc + ")")(budgetIn, tapIn),
      PROBE, budget, tapCases
    );
  } finally {
    await browser.close();
  }
}

const servers = [];
try {
  const server = await serveOn(ROOT);
  servers.push(server.proc);
  await new Promise((r) => setTimeout(r, 800));

  const errors = [];
  let results = null;
  let launchError = null;
  for (let tries = 0; tries < 2 && results == null; tries += 1) {
    if (tries) await new Promise((r) => setTimeout(r, 1500));
    try {
      results = await attempt(server.base, errors, BUDGET);
      if (results == null) {
        console.log("  SKIPPED: marked/DOMPurify unavailable (no CDN and no vendored copy)");
        process.exit(0);
      }
    } catch (e) {
      launchError = e;
    }
  }
  if (results == null) throw launchError || new Error("interaction-scale-check could not run");

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const tail = r.ok ? (r.measured ? `  ·  ${r.measured}` : "") : `\n        ${r.detail}`;
    console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${tail}`);
  }
  const real = errors.filter((e) => !/marked is not defined|renderMathInElement/.test(e));
  for (const e of real.slice(0, 5)) console.log(`  PAGE ERROR  ${e.split("\n")[0]}`);
  console.log(`\n${results.length} interaction cases · ${failed.length} failed${real.length ? ` · ${real.length} page error(s)` : ""}`);
  process.exitCode = failed.length || real.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}
