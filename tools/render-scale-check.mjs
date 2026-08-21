// Does a note still render when it is BIG?
//
//   node tools/render-scale-check.mjs
//
// This check exists because its absence let a total failure of large notes pass
// thirteen green checks.
//
// `patchRenderedBlocks` takes a different path above NOTES_CHUNK_MIN_BLOCKS
// (2,000 blocks): the note's blocks are grouped into `.notes-chunk` wrappers so
// the engine tracks ~600 containment boxes instead of 24,600. Nothing in the
// suite rendered a note that big — every fixture in ui-smoke, behaviour-parity,
// selection-check, paged-check and ribbon-check is a few hundred blocks at most
// — so the entire chunked branch was untested, and a rewrite of it that threw
// `NotFoundError` on every note over 2,000 blocks shipped green.
//
// So: render at four sizes that straddle the threshold, and assert the boring
// things. A note that does not render is not a subtle bug and does not need a
// subtle test; it needs a test that exists.

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
if (!puppeteer || !CHROME) { console.log("render-scale-check: no puppeteer/Chrome — skipping."); process.exit(0); }

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

const PROBE = `async (api) => {
  const results = [];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const push = (name, detail) => results.push({ name, ok: detail === true, detail: detail === true ? "" : String(detail) });

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("render-scale-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Scale fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  const view = document.getElementById("notesView");
  if (!view || view.clientWidth < 200) {
    return [{ name: "setup", ok: false, detail: "#notesView is " + (view ? view.clientWidth : "missing") + "px wide — nothing below would mean anything" }];
  }

  const make = (chapters, sections) => {
    const out = [];
    for (let c = 0; c < chapters; c += 1) {
      out.push("# Chapter " + (c + 1) + "\\n");
      for (let s = 0; s < sections; s += 1) {
        out.push("## Section " + (c + 1) + "." + (s + 1) + "\\n");
        out.push("Paragraph " + (s + 1) + " of chapter " + (c + 1) + ". " +
          "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore. ".repeat(3) + "\\n");
        out.push("- bullet one\\n- bullet two\\n- bullet three\\n");
      }
    }
    return out.join("\\n");
  };

  // Straddling NOTES_CHUNK_MIN_BLOCKS (2,000) in both directions. The three
  // large ones are the whole point: they take the chunked branch. The last is a
  // 2.6MB book, which is the size at which this stopped working at all.
  const sizes = [[4, 10], [10, 20], [20, 40], [40, 60], [60, 100]];

  for (const [chapters, sections] of sizes) {
    const md = make(chapters, sections);
    api.state.notes = md;

    let expected = 0;
    try { expected = api.splitPreparedBlocks(api.preprocessSpecialBlocks(md)).blocks.length; }
    catch (e) { push(md.length + " chars — the source splits into blocks", "splitPreparedBlocks threw: " + e.message); continue; }

    const label = expected + " blocks";
    let threw = "";
    const started = performance.now();
    try { await api.renderNotesView(); } catch (e) { threw = e.name + ": " + e.message; }
    const took = performance.now() - started;
    await settle(200);

    push(label + " — renders without throwing", threw ? threw : true);
    if (threw) continue;

    // ── Every block reaches the DOM ───────────────────────────────────────
    //
    // On a note big enough to be built as it is READ (see the viewport-driven
    // rendering note in src/render/block-cache.js) that is deliberately not
    // true on open — not building the far end of a book is the entire point.
    // So the question is asked in two halves, and the second half is what stops
    // "cheap" from quietly meaning "wrong":
    //
    //   1. what is on screen now is a real, non-empty part of the note, and
    //      strictly less than all of it;
    //   2. asking for the rest produces EXACTLY the block list a whole-document
    //      lex gives — same count, same order.
    const lazy = api.notesLazyStats(view);
    if (lazy) {
      push(label + " — opens without building the whole note", (() => {
        const blocks = api.notesTopLevelBlocks(view);
        if (!blocks.length) return "nothing rendered at all";
        if (blocks.length >= expected) return "built all " + blocks.length + " blocks — nothing was deferred";
        if (lazy.built >= lazy.spans) return "built all " + lazy.spans + " spans";
        return true;
      })());
      await api.materializeNotesLazySpans(view);
      await settle(120);
    }
    push(label + " — every block reaches the DOM", (() => {
      const blocks = api.notesTopLevelBlocks(view);
      if (blocks.length !== expected) return "expected " + expected + " top-level blocks, found " + blocks.length;
      return true;
    })());

    // Above the threshold the chunked branch must actually have been taken —
    // otherwise this check is passing without exercising the code it exists for.
    push(label + " — takes the branch it is meant to", (() => {
      const chunked = view.querySelectorAll(":scope > .notes-chunk").length > 0;
      const shouldChunk = expected >= 2000;
      if (chunked !== shouldChunk) {
        return shouldChunk ? "expected chunk wrappers and found none" : "unexpectedly chunked";
      }
      return true;
    })());

    push(label + " — renders inside the budget", took > 4000 ? Math.round(took) + "ms" : true);

    // ── A same-note re-render, which is what every edit does ───────────────
    //
    // The rewrite that broke this threw HERE rather than on the first render:
    // the chunked re-home only runs when there are existing wrappers to reuse.
    view.scrollTop = Math.min(600, Math.max(0, view.scrollHeight - view.clientHeight));
    await settle(120);
    const before = view.scrollTop;
    // The chunk wrappers as they are RIGHT NOW. content-visibility: auto
    // remembers the size a box last laid out at, and that memory belongs to the
    // element — so rebuilding the wrappers on every repaint threw it away for
    // every off-screen chunk and the document's height changed underneath the
    // reader. Keeping the same elements is the entire reason this code was
    // touched, and nothing else measures it.
    const wrappersBefore = Array.from(view.querySelectorAll(":scope > .notes-chunk"));
    let editThrew = "";
    try {
      api.state.notes = md.replace("Paragraph 1 of chapter 1.", "Paragraph 1 of chapter 1 <mark>edited</mark>.");
      await api.renderNotesViewPinned();
    } catch (e) { editThrew = e.name + ": " + e.message; }
    await settle(600);

    push(label + " — an edit re-renders without throwing", editThrew ? editThrew : true);
    if (editThrew) continue;
    push(label + " — an edit does not move the reader", (() => {
      const moved = Math.abs(view.scrollTop - before);
      if (moved > 8) return "scrollTop moved " + Math.round(moved) + "px";
      return true;
    })());
    push(label + " — the edit actually landed", view.querySelectorAll("mark").length ? true : "no <mark> in the rendered note");
    if (wrappersBefore.length) {
      push(label + " — the chunk wrappers survive the edit", (() => {
        const after = Array.from(view.querySelectorAll(":scope > .notes-chunk"));
        if (after.length !== wrappersBefore.length) {
          return "chunk count changed from " + wrappersBefore.length + " to " + after.length;
        }
        const reused = after.filter((node, i) => node === wrappersBefore[i]).length;
        // Every one of them, not most: a single rebuilt wrapper is a chunk that
        // forgot its height.
        if (reused !== after.length) return reused + " of " + after.length + " wrappers are the same elements";
        return true;
      })());
    }
  }

  // ── Does the reader's finger get through while a book is opening? ────────
  //
  // Reported as "I have to long press continuously to invoke text selection".
  // The browser starts a selection on a long press only if the touch stays put
  // AND the events are delivered on time; a press that lands inside a long
  // synchronous task is delivered late and gets classified as a scroll instead.
  //
  // Long-press selection itself cannot be tested here — it is browser UI, and
  // headless Chrome does not implement it. Verified directly: synthesised
  // Input.dispatchTouchEvent long-presses select nothing even on a bare page
  // with no app involved, so a check written that way would be measuring the
  // harness and would stay red no matter what the app did.
  //
  // What IS measurable, and is the actual cause, is how long the main thread
  // stops answering. That is what these two assert.
  {
    // Deliberately NOT one of the sizes rendered above: an identical note is
    // already in the block cache and renderMarkdown returns immediately, so the
    // measurement would be of nothing at all. Unique text forces the cold path,
    // which is the one a reader opening a book actually takes.
    const md = make(60, 100).replace(/Paragraph /g, "Fresh paragraph ");
    api.state.notes = md;
    api.setNotesScrolledSource(null);
    api.invalidateRenderedBlockCache();

    const probe = await (async () => {
      const view2 = document.getElementById("notesView");
      let longest = 0;
      let observer = null;
      try {
        observer = new PerformanceObserver((list) => {
          list.getEntries().forEach((e) => { longest = Math.max(longest, e.duration); });
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch (_) { observer = null; }

      // A frame heartbeat, running for the WHOLE render. A requestAnimationFrame
      // callback cannot run while a synchronous task is in progress, so the
      // longest gap between two of them is the longest the page could not have
      // answered a finger. Unlike a dispatched event — whose delivery can
      // happen to land in a gap between bursts and pass for the wrong reason —
      // this covers every millisecond of the render window.
      let worstGap = 0;
      let last = performance.now();
      let beating = true;
      const beat = () => {
        const now = performance.now();
        worstGap = Math.max(worstGap, now - last);
        last = now;
        if (beating) requestAnimationFrame(beat);
      };
      requestAnimationFrame(beat);

      // Let the heartbeat establish a baseline before the work starts, so the
      // very first gap is not just "the time until the first frame".
      await settle(120);
      last = performance.now();
      worstGap = 0;

      // Time until the reader can SEE the note, which is what "opening a book
      // feels instant" actually means. Polled rather than awaited: the render
      // yields to a frame between batches precisely so the browser can paint
      // partial content, and the whole point is that this lands long before the
      // render finishes.
      let firstPaint = null;
      const started = performance.now();
      const poll = setInterval(() => {
        if (firstPaint === null && view2.querySelectorAll("p,h1,h2,h3,li").length > 0) {
          firstPaint = performance.now() - started;
        }
      }, 8);
      api.renderNotesView();   // deliberately not awaited — measure it running
      await settle(4000);
      clearInterval(poll);
      const total = performance.now() - started;

      beating = false;
      observer?.disconnect();
      return { longest: Math.round(longest), worstGap: Math.round(worstGap), total: Math.round(total), firstPaint: firstPaint === null ? null : Math.round(firstPaint) };
    })();

    // THE user-facing one: a 2.6MB note used to show nothing at all until the
    // whole thing was built (measured: first visible block at 876ms, i.e. never
    // before the end). It is now streamed in batches with a frame between them.
    push("a big note shows its first text quickly", (() => {
      if (probe.firstPaint === null) return "nothing was painted before the render finished";
      if (probe.firstPaint > 350) return "first visible text after " + probe.firstPaint + "ms";
      return true;
    })());

    // The remaining single task is the synchronous prefix every render needs
    // before it can batch anything: promoteNotesHeadings, preprocessSpecialBlocks
    // and marked.lexer over the whole document (measured 5 + 11 + 124ms on an
    // 18,000-block note). Splitting the LEXER is the next real step and is not
    // done — this budget is set where the work actually is, not where it would
    // ideally be, so that a regression still shows up.
    push("a big note never blocks the main thread for long", (() => {
      if (probe.longest <= 0) return true; // no longtask support; the next case still covers it
      if (probe.longest > 350) return "longest blocking task was " + probe.longest + "ms while the note rendered";
      return true;
    })());

    push("a big note never drops a long run of frames", (() => {
      if (probe.worstGap > 350) return "the page could not answer for " + probe.worstGap + "ms while the note rendered";
      return true;
    })());
  }

  return results;
}`;

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/render/block-cache.js?v=__BUILD__"),
    import("/src/render/preprocess.js?v=__BUILD__"),
    import("/src/notes/notes-view.js?v=__BUILD__"),
    import("/src/notes/paged-view.js?v=__BUILD__"),
    import("/src/ui/view-mode.js?v=__BUILD__"),
    import("/src/ui/boot-screens.js?v=__BUILD__"),
    import("/src/cloud/supabase-client.js?v=__BUILD__"),
    import("/src/cards/new-deck.js?v=__BUILD__"),
    import("/src/boot.js?v=__BUILD__"),
    import("/src/core/state.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

async function attempt(base, errors) {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on("pageerror", (e) => errors.push(e.message));
    // Injected BEFORE navigation: the app's own boot needs marked/DOMPurify, and
    // adding them afterwards leaves half its wiring undone.
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
    return await page.evaluate(
      async (probeSrc, apiSrc) => {
        const api = await (0, eval)(apiSrc)();
        return await (0, eval)("(" + probeSrc + ")")(api);
      },
      PROBE, API_SRC
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
      results = await attempt(server.base, errors);
      if (results == null) {
        console.log("  SKIPPED: marked/DOMPurify unavailable (no CDN and no vendored copy)");
        process.exit(0);
      }
    } catch (e) {
      launchError = e;
    }
  }
  if (results == null) throw launchError || new Error("render-scale-check could not run");

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  // Page errors matter here as much as the assertions: a throw inside a render
  // is swallowed by the promise chain and shows up only as a console error.
  const real = errors.filter((e) => !/marked is not defined|renderMathInElement/.test(e));
  for (const e of real.slice(0, 5)) console.log(`  PAGE ERROR  ${e.split("\n")[0]}`);
  console.log(`\n${results.length} scale cases · ${failed.length} failed${real.length ? ` · ${real.length} page error(s)` : ""}`);
  process.exitCode = failed.length || real.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}
