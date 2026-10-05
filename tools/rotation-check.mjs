// Does the reader stay on what they were reading when the phone turns?
//
//   node tools/rotation-check.mjs
//
// "Jumping from landscape to portrait, both in PDF and notes, I'm seeing
// significant content jump."
//
// A phone turned on its side is the biggest re-flow this app goes through: the
// width more than doubles, the PDF re-fits every page to it, the note re-wraps
// every line, and most phones cross the 720px breakpoint on the way. Each case
// below turns an emulated phone 390x844 -> 844x390 -> 390x844 and asserts on
// CONTENT — the paragraph on the reading line, the page under the top of the
// scroller — never a scroll offset, which is meant to change.
//
//   1. Notes, continuous: the paragraph on the reading line survives both
//      turns, and so does the position written down for the next open.
//   2. Notes, paged: the block at the top of the page the reader was on is on
//      the page they are shown after each turn.
//   3. A phone on its side keeps the phone style profile — the text does not
//      jump from 15px to 18px under the reader.
//   4. PDF, fit-width: the page and how far down it survive both turns, and
//      the page saved is that page, including the turn back to portrait, where
//      the shorter document clamps scrollTop.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources } from "./pdfjs-source.mjs";
import { buildFixturePdf } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHDOG_MS = 3 * 60 * 1000;

let failures = 0;
let ran = 0;
function check(condition, name, detail = "") {
  ran += 1;
  if (condition) console.log(`ok   ${name}${detail ? `  [${detail}]` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `  [${detail}]` : ""}`);
  }
}

// Two paragraph markers within a paragraph of each other: a long paragraph
// re-wrapped at a new width can put the reading line on the blank margin that
// ends the one above it.
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
    "/src/notes/paged-view.js?v=__BUILD__",
    "/src/notes/scroll-anchor.js?v=__BUILD__",
    "/src/notes/reading-position.js?v=__BUILD__",
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("rotation-check does not touch the network"); },
    storage: { from: () => ({
      upload: async () => ({ error: { message: "offline in this check" } }),
      remove: async () => ({ error: null }),
      list: async () => ({ data: [], error: null }),
      createSignedUrls: async () => ({ data: [], error: null })
    }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Rotation fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(400);

  // Paragraphs long enough to wrap to several lines at 390px and fewer at
  // 844px, so a turn changes every block's height — the whole of what moves a
  // reader who is not held.
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");
  const lines = ["# Rotation probe", ""];
  for (let i = 0; i < 300; i += 1) lines.push("P" + String(i).padStart(4, "0") + " " + words.join(" ") + " " + words.join(" ") + ".", "");
  api.state.notes = lines.join("\\n");
  api.state.localDeckId = "rotation-local";
  api.renderNotesView();
  await settle(800);

  const view = document.getElementById("notesView");
  window.__reading = () => {
    const block = api.notesBlockAtReadingLineGeometric();
    return block ? (block.textContent || "").trim().slice(0, 5) : "";
  };
  window.__scrollTo = (marker) => {
    const target = Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith(marker));
    if (!target) return false;
    const delta = target.getBoundingClientRect().top - view.getBoundingClientRect().top;
    view.scrollTop = Math.max(0, view.scrollTop + delta - 8);
    view.dispatchEvent(new Event("scroll"));
    return true;
  };
  window.__markerAt = (offset) => {
    const notes = api.state.notes;
    const at = notes.lastIndexOf("\\nP", offset);
    return at < 0 ? notes.slice(0, 5) : notes.slice(at + 1, at + 6);
  };
  window.__stored = () => {
    api.flushReadingPositionSave();
    const stored = api.readStoredReadingPosition(api.currentDeckKey());
    return stored ? window.__markerAt(stored.offset) : null;
  };
  return { paragraphs: view.querySelectorAll("p").length };
}`;

async function turn(page, width, height) {
  const landscape = width > height;
  await page.call("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 2, mobile: true,
    screenOrientation: { type: landscape ? "landscapePrimary" : "portraitPrimary", angle: landscape ? 90 : 0 }
  });
}

async function run() {
  const chrome = findChrome();
  if (!chrome) {
    console.log("rotation-check: no Chrome on this machine — skipping.");
    return 0;
  }
  let sources = null;
  try {
    sources = pdfjsSources();
  } catch (error) {
    console.log(`rotation-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — the PDF case will be skipped.`);
  }
  const server = await serveOn(ROOT);
  let browser = null;
  const errors = [];
  const watchdog = setTimeout(() => {
    console.log(`FAIL the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
    try { browser?.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
    try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
    process.exit(1);
  }, WATCHDOG_MS);
  try {
    browser = await launchChrome(chrome);
    const client = await connect(browser.wsUrl);
    const page = await openPage(client);
    await emulatePhone(page, { width: 390, height: 844 });
    await page.call("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*"] });
    if (sources) {
      await page.call("Page.addScriptToEvaluateOnNewDocument", {
        source: `${sources.main}
;(function () {
  try {
    var blob = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) { console.warn("check: could not install the pdf.js worker", e); }
})();`
      });
    }
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
      console.log("rotation-check: markdown libraries never loaded — skipping.");
      return 0;
    }
    await wait(1500);
    const setup = await page.evaluate(new Function(`return (${SETUP_SRC})`)());
    if (!setup || setup.paragraphs < 200) {
      console.log(`rotation-check: the fixture is ${setup ? `${setup.paragraphs} paragraphs` : "missing"} — nothing below would mean anything`);
      return 1;
    }
    check(true, "the notes fixture rendered", `${setup.paragraphs} paragraphs`);

    // ── 1. Notes, continuous ─────────────────────────────────────────────────
    await page.evaluate(() => window.__scrollTo("P0150"));
    // Past the anchor capture and the position store's 2s debounce.
    await wait(2600);
    const read = () => page.evaluate(() => ({
      reading: window.__reading(),
      stored: window.__stored(),
      scrollTop: Math.round(document.getElementById("notesView").scrollTop),
      profile: window.__recall.api.state.activeStyleProfile,
      fontSize: getComputedStyle(document.getElementById("notesView")).fontSize
    }));
    const portrait = await read();
    await turn(page, 844, 390);
    await wait(2600);
    const landscape = await read();
    await turn(page, 390, 844);
    await wait(2600);
    const back = await read();
    check(portrait.reading === "P0150" && near(portrait.stored, "P0150"),
      "reading well into the note in portrait, and that is the stored position",
      `on ${portrait.reading}, stored at ${portrait.stored}`);
    check(near(landscape.reading, portrait.reading),
      "turned to landscape, the reader is on the same paragraph",
      `${portrait.reading} -> ${landscape.reading} (scrollTop ${portrait.scrollTop} -> ${landscape.scrollTop})`);
    check(near(landscape.stored, portrait.reading),
      "...and the stored position did not move with the re-flow",
      `stored at ${landscape.stored}`);
    check(near(back.reading, portrait.reading),
      "turned back to portrait, still the same paragraph",
      `${landscape.reading} -> ${back.reading} (scrollTop ${landscape.scrollTop} -> ${back.scrollTop})`);
    check(near(back.stored, portrait.reading),
      "...and still the same stored position",
      `stored at ${back.stored}`);

    // ── 3. The style profile stays on the phone's ────────────────────────────
    check(portrait.profile === "mobile" && landscape.profile === "mobile",
      "a phone on its side keeps the phone style profile",
      `portrait ${portrait.profile} (${portrait.fontSize}), landscape ${landscape.profile} (${landscape.fontSize})`);
    check(landscape.fontSize === portrait.fontSize,
      "...so the note's text is the same size either way up",
      `${portrait.fontSize} -> ${landscape.fontSize}`);

    // ── 2. Notes, paged ──────────────────────────────────────────────────────
    const pagedRead = () => page.evaluate((marker) => {
      const { api } = window.__recall;
      const view = document.getElementById("notesView");
      const first = api.firstVisibleNotesBlock();
      const held = marker
        ? Array.from(view.querySelectorAll("p")).find((p) => p.textContent.startsWith(marker))
        : null;
      return {
        first: first ? (first.textContent || "").trim().slice(0, 5) : "",
        page: api.notesCurrentPage(),
        pages: api.notesPageCount(),
        heldPage: held ? api.notesPageForElement(held) : null
      };
    }, null);
    await page.evaluate(async () => {
      const { api, settle } = window.__recall;
      api.setNotesReadingMode("paged-1");
      await settle(600);
      api.goToNotesPage(Math.floor(api.notesPageCount() / 2), { smooth: false });
      await settle(600);
    });
    const pagedPortrait = await pagedRead();
    const heldAt = (marker) => page.evaluate((m) => {
      const { api } = window.__recall;
      const node = Array.from(document.querySelectorAll("#notesView p")).find((p) => p.textContent.startsWith(m));
      return { page: api.notesCurrentPage(), heldPage: node ? api.notesPageForElement(node) : null, first: (api.firstVisibleNotesBlock()?.textContent || "").trim().slice(0, 5) };
    }, marker);
    await turn(page, 844, 390);
    await wait(1500);
    const pagedLandscape = await heldAt(pagedPortrait.first);
    await turn(page, 390, 844);
    await wait(1500);
    const pagedBack = await heldAt(pagedPortrait.first);
    check(/^P\d{4}$/.test(pagedPortrait.first) && pagedPortrait.page > 0,
      "paged: reading mid-note in portrait",
      `page ${pagedPortrait.page + 1} of ${pagedPortrait.pages}, starting at ${pagedPortrait.first}`);
    // Not on the first page: a layout thrown back to the start of the note has
    // every block "on the page shown" if the page is the one they are all on.
    check(pagedLandscape.heldPage === pagedLandscape.page && pagedLandscape.page > 0,
      "paged: turned to landscape, the page shown holds the paragraph the reader was on",
      `${pagedPortrait.first} is on page ${pagedLandscape.heldPage + 1}, showing page ${pagedLandscape.page + 1} (starts at ${pagedLandscape.first})`);
    check(pagedBack.heldPage === pagedBack.page && pagedBack.page === pagedPortrait.page,
      "paged: turned back to portrait, still that paragraph's page",
      `${pagedPortrait.first} is on page ${pagedBack.heldPage + 1}, showing page ${pagedBack.page + 1} (starts at ${pagedBack.first})`);
    // ...and a second turn and back. A page holds several blocks, and taking a
    // different one of them as the anchor on every turn walks the reader one
    // block further back each time; one round trip does not show that.
    await turn(page, 844, 390);
    await wait(1500);
    await turn(page, 390, 844);
    await wait(1500);
    const pagedTwice = await heldAt(pagedPortrait.first);
    check(pagedTwice.heldPage === pagedTwice.page && pagedTwice.page === pagedPortrait.page,
      "paged: a second turn and back is still the page the reader started on",
      `${pagedPortrait.first} is on page ${pagedTwice.heldPage + 1}, showing page ${pagedTwice.page + 1}, started on ${pagedPortrait.page + 1}`);
    await page.evaluate(async () => {
      window.__recall.api.setNotesReadingMode("continuous");
      await window.__recall.settle(400);
    });

    // ── 4. PDF, fit-width ────────────────────────────────────────────────────
    if (sources) {
      const fixture = buildFixturePdf({ pages: 40, annotate: false, outline: false });
      const opened = await page.evaluate(async (bytes) => {
        const { api, settle } = window.__recall;
        const file = new File([new Uint8Array(bytes)], "rotation.pdf", { type: "application/pdf" });
        await api.importPdfFile(file, null);
        await settle(400);
        const entry = api.readLocalDeckIndex().find((m) => m.title && m.title !== "Rotation fixture" && m.title !== "Untitled deck");
        if (!entry) return { error: "no PDF deck was created" };
        await api.loadDeckFromLibrary(entry.id);
        await settle(400);
        api.setViewMode("document");
        await settle(200);
        await api.openDocumentView({ force: true });
        await settle(800);
        return { pages: api.currentPdfPageCount(), fitWidth: api.isDocumentFitWidth() };
      }, Array.from(fixture.bytes));
      if (opened.error) throw new Error(opened.error);
      check(opened.pages === 40 && opened.fitWidth, "the PDF fixture opened at fit-width", `${opened.pages} pages`);

      const pdfRead = () => page.evaluate(() => {
        const { api } = window.__recall;
        return {
          page: api.currentDocumentPage(),
          ratio: Number(api.currentDocumentRatio().toFixed(3)),
          saved: api.state.meta?.readingPosition?.pdfPage ?? null,
          scrollTop: Math.round(document.getElementById("documentView").scrollTop)
        };
      });
      // Page 30 of 40: far enough down that the turn back to portrait leaves
      // scrollTop past the end of the shorter document, which is the clamp
      // that used to save the wrong page.
      await page.evaluate(async () => {
        const { api, settle } = window.__recall;
        api.scrollToDocumentPage(30, 0.5, { smooth: false });
        await settle(800);
      });
      const pdfPortrait = await pdfRead();
      await turn(page, 844, 390);
      await wait(1500);
      const pdfLandscape = await pdfRead();
      await turn(page, 390, 844);
      await wait(1500);
      const pdfBack = await pdfRead();
      const same = (a, b) => a.page === b.page && Math.abs(a.ratio - b.ratio) <= 0.05;
      check(pdfPortrait.page === 30 && pdfPortrait.saved === 30,
        "PDF: on page 30 in portrait, and that is the saved page",
        `page ${pdfPortrait.page} at ${pdfPortrait.ratio}, saved ${pdfPortrait.saved}`);
      check(same(pdfLandscape, pdfPortrait),
        "PDF: turned to landscape, the same page and the same place on it",
        `page ${pdfLandscape.page} at ${pdfLandscape.ratio} (scrollTop ${pdfPortrait.scrollTop} -> ${pdfLandscape.scrollTop})`);
      check(pdfLandscape.saved === 30, "...and the saved page is still 30", `saved ${pdfLandscape.saved}`);
      check(same(pdfBack, pdfPortrait),
        "PDF: turned back to portrait, the same page and place",
        `page ${pdfBack.page} at ${pdfBack.ratio} (scrollTop ${pdfLandscape.scrollTop} -> ${pdfBack.scrollTop})`);
      check(pdfBack.saved === 30, "...and the clamp on the way did not save another page", `saved ${pdfBack.saved}`);
    }

    check(errors.length === 0, "no uncaught errors", errors.slice(0, 3).join(" | "));
  } finally {
    clearTimeout(watchdog);
    if (browser) browser.close();
    server.proc.kill();
  }
  console.log(`\nCHECK: ${ran} checks · ${failures} failed`);
  return failures ? 1 : 0;
}

run().then((code) => process.exit(code), (error) => {
  console.log(`FAIL rotation-check: ${error?.stack || error}`);
  process.exit(1);
});
