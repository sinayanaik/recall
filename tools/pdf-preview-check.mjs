// Does a PDF deck actually work — read, highlighted, and reloaded?
//
//   node tools/pdf-preview-check.mjs
//   node tools/pdf-preview-check.mjs some-real-paper.pdf   # ...against your own
//   node tools/pdf-preview-check.mjs --shot=document.png
//
// Modelled on tools/epub-preview-check.mjs in intent — run the app's OWN import
// and reading code in a real browser rather than reimplementing any of it — and
// on tools/notes-menu-check.mjs in mechanism, because it speaks CDP directly
// (tools/cdp.mjs) instead of skipping itself wherever puppeteer is not
// installed. A check that skips is a check that never catches anything.
//
// Five things are asserted, and each one is a failure this feature can have
// that nothing else in tools/ would notice:
//
//   1. the import produces ONE deck, with meta.pdf and a page count;
//   2. every page renders a text layer with items in it. A page that renders
//      ZERO text items is the signal for a scanned PDF with no text layer —
//      readable, but with no selection, no highlights and no make-card. It is
//      reported loudly rather than passing quietly, because everything else
//      about such a document looks fine;
//   3. the file's OWN highlights (a Zotero-shaped annotation with a comment)
//      arrive as records, with the comment landing in the note's "## Highlight
//      Notes" section — the one place where the reuse of the markdown machinery
//      either holds or silently does not;
//   4. a selection over a known range on page 3 becomes a highlight with the
//      expected { page, item, ch } and real quads;
//   5. ...and after the deck is dropped from memory and re-read from IndexedDB,
//      the SAME quads repaint. That last step is the whole anchoring design
//      under test: coordinates that only work in the session that made them
//      would pass every other assertion here.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";
import { FONT_SIZE, buildFixturePdf, fixtureLineOrigin } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SHOT = (args.find((a) => a.startsWith("--shot=")) || "").slice(7)
  || (args.includes("--shot") ? "pdf-document.png" : "");
const OWN_PDF = args.find((a) => a.endsWith(".pdf"));
// --shot-menu opens the ⇓ export menu before the shot is taken.
const SHOT_MENU = args.includes("--shot-menu");
// --shot-pages takes the shot on a PHONE with the printed notes turned on: the
// two things that only meet there are a page fitted edge to edge and the sheet
// of notes under it, and neither is visible in the desktop shot above.
const SHOT_PAGES = args.includes("--shot-pages");
// --shot-notes takes it on the Highlights tab instead, which is where a paper's
// notes are written (src/panels/highlights-editor.js).
const SHOT_NOTES = args.includes("--shot-notes");
// --shot-toc opens the contents drawer, on its Highlights half. That drawer was
// unreachable for its whole life (a missing .is-open class and a --toc-width
// that did not resolve outside .notes-stage), and every assertion about it
// passed the entire time, because they all read its DOM. A picture of it is the
// cheapest guard against the next thing that only fails on the glass.
const SHOT_TOC = args.includes("--shot-toc");
// ...and --shot-toc=contents for the other half.
const SHOT_TOC_SECTION = args.includes("--shot-toc-contents") ? "contents" : "highlights";

// ── pdf.js, locally ─────────────────────────────────────────────────────────
//
// The app loads pdf.js from jsdelivr (LIB_URLS.pdfjs) and the service worker
// precaches it, which is right for a browser and useless to a check running on
// a machine that may have no route to a CDN at all. So the same version is
// fetched once from npm and cached under /tmp, exactly as
// epub-preview-check.mjs caches jszip — and then INJECTED, which also means
// this check exercises ensurePdfJs's "the library is already on window" path
// rather than depending on a network fetch mid-run.
//
// The version here must match LIB_URLS.pdfjs. A check that passes against a
// different pdf.js than the app ships is a check that proves nothing.
const PDFJS_VERSION = "3.11.174";
const CACHE_DIR = "/tmp/recall-pdfjs";

function pdfjsSources() {
  const build = path.join(CACHE_DIR, "package/legacy/build");
  const main = path.join(build, "pdf.min.js");
  const worker = path.join(build, "pdf.worker.min.js");
  if (!existsSync(main) || !existsSync(worker)) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tarball = `pdfjs-dist-${PDFJS_VERSION}.tgz`;
    if (!existsSync(path.join(CACHE_DIR, tarball))) {
      execFileSync("npm", ["pack", `pdfjs-dist@${PDFJS_VERSION}`], { cwd: CACHE_DIR, stdio: "ignore" });
    }
    execFileSync("tar", [
      "xzf", tarball,
      "package/legacy/build/pdf.min.js",
      "package/legacy/build/pdf.worker.min.js"
    ], { cwd: CACHE_DIR, stdio: "ignore" });
  }
  return { main: readFileSync(main, "utf8"), worker: readFileSync(worker, "utf8") };
}

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
    const deadline = setTimeout(() => reject(new Error("static server did not start")), 10000);
    proc.stdout.on("data", () => clearTimeout(deadline));
    proc.on("error", (error) => { clearTimeout(deadline); reject(error); });
  });
}

// The app exposes no global API, so the modules the check drives are imported
// and flattened into one object — the same approach as notes-menu-check's
// API_SRC and mobile-menu-check's.
const API_SRC = `async () => {
  const paths = [
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-selection.js?v=__BUILD__",
    "/src/documents/pdf-highlights.js?v=__BUILD__",
    "/src/documents/pdf-outline.js?v=__BUILD__",
    "/src/documents/pdf-store.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/format/highlight-notes.js?v=__BUILD__",
    "/src/format/notes-fence.js?v=__BUILD__",
    "/src/documents/pdf-export.js?v=__BUILD__",
    "/src/export/run.js?v=__BUILD__",
    "/src/export/pdf.js?v=__BUILD__",
    "/src/export/notes-body.js?v=__BUILD__",
    "/src/panels/highlights-panel.js?v=__BUILD__",
    "/src/notes/highlight-note-editor.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/documents/pdf-region.js?v=__BUILD__",
    "/src/documents/pdf-page-notes.js?v=__BUILD__",
    "/src/panels/highlights-editor.js?v=__BUILD__",
    "/src/panels/drawer-highlights.js?v=__BUILD__",
    "/src/panels/highlight-cycle.js?v=__BUILD__",
    "/src/notes/notes-edit-split.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/reading-rail.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    // Last, so nothing here can shadow a name one of the modules above owns —
    // the flatten keeps the FIRST module to export a key.
    "/src/notes/touch-selection.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

const SETUP_SRC = `async (apiSrc) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  // Signed in, but with a client that refuses every network call. The import
  // has to reach the "could not upload, kept it on this device" branch, which
  // is both the offline story and the branch a check can actually run.
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("pdf-preview-check does not touch the network"); },
    storage: { from: () => ({
      upload: async () => ({ error: { message: "offline in this check" } }),
      remove: async () => ({ error: null }),
      list: async () => ({ data: [], error: null }),
      createSignedUrls: async () => ({ data: [], error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: "https://example.supabase.co/storage/v1/object/public/images/" + p } })
    }) }
  });
  // The app's own boot has to land first — see the same wait in
  // notes-menu-check for what happens when it does not.
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  return true;
}`;

// ── A hard ceiling on the whole run ─────────────────────────────────────────
//
// tools/check.mjs runs every check through spawnSync and reads its output when
// it exits, so a check that hangs does not fail the suite — it stops it, with
// nothing on screen to say which one. This one drives a real browser through a
// real PDF, which is more moving parts than most, so it is given an explicit
// deadline and turns a hang into an ordinary failure with a name on it.
export const WATCHDOG_MS = 5 * 60 * 1000;

const chrome = findChrome();
if (!chrome) { console.log("pdf-preview-check: no Chrome on this machine — skipping."); process.exit(0); }

let sources;
try {
  sources = pdfjsSources();
} catch (error) {
  console.log(`pdf-preview-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — skipping.`);
  process.exit(0);
}

const fixture = OWN_PDF
  ? { bytes: new Uint8Array(readFileSync(OWN_PDF)), pages: null, linesPerPage: null, title: path.basename(OWN_PDF), annotation: null }
  : buildFixturePdf();

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

// Armed only once there is something to tear down. Everything it kills is
// killed again by the finally below on the normal path; doing it here as well
// is what makes the deadline reliable rather than advisory.
const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  process.exit(1);
}, WATCHDOG_MS);

const failures = [];
const notes = [];
function check(label, ok, detail = "") {
  if (ok) console.log(`  ok    ${label}${detail ? `  ${detail}` : ""}`);
  else {
    console.log(`  FAIL  ${label}${detail ? `  ${detail}` : ""}`);
    failures.push(label);
  }
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });

  // pdf.js, before the app's own scripts run — so ensurePdfJs finds it already
  // on window and sets no workerSrc of its own. The worker is a blob of the
  // same local source, which is what ensurePdfJs would have built from the CDN
  // copy; without it pdf.js falls back to a main-thread fake worker whose own
  // source resolution has nothing to resolve against here.
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${sources.main}
;(function () {
  try {
    var blob = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) { console.warn("check: could not install the pdf.js worker", e); }
})();`
  });

  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  // ── 1. Import ────────────────────────────────────────────────────────────
  const imported = await page.evaluate(`async (bytes, name) => {
    const { api, settle } = window.__recall;
    const file = new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
    await api.importPdfFile(file, null);
    await settle(400);
    const index = api.readLocalDeckIndex();
    const entry = index.find((m) => m.title && m.title !== "Untitled deck") || index[0];
    if (!entry) return { error: "no deck was created" };
    await api.loadDeckFromLibrary(entry.id);
    await settle(400);
    return {
      decks: index.length,
      title: api.state.deckTitle,
      pdf: api.state.meta?.pdf || null,
      highlights: (api.state.meta?.pdfHighlights || []).length,
      notes: api.state.notes || "",
      viewMode: api.state.viewMode
    };
  }`, Array.from(fixture.bytes), OWN_PDF ? path.basename(OWN_PDF) : "fixture.pdf");

  if (imported.error) throw new Error(imported.error);
  check("import creates one deck", imported.decks === 1, `${imported.decks} deck(s) · “${imported.title}”`);
  check("the deck carries meta.pdf", Boolean(imported.pdf), imported.pdf ? `${imported.pdf.pages} page(s), sha256 ${String(imported.pdf.sha256).slice(0, 12)}…` : "no meta.pdf");
  check("the deck opens on its Document tab", imported.viewMode === "document", `viewMode = ${imported.viewMode}`);
  if (fixture.pages) {
    check("the page count is read from the file", imported.pdf?.pages === fixture.pages, `${imported.pdf?.pages} vs ${fixture.pages}`);
    check("the title comes from the PDF's own metadata", imported.title === fixture.title, `“${imported.title}”`);
  }

  // ── 3. The file's own highlights ─────────────────────────────────────────
  if (fixture.annotation) {
    check("an existing PDF highlight is imported", imported.highlights === 1, `${imported.highlights} record(s)`);
    // The fence, not the "## Highlight Notes" heading this used to assert. The
    // heading is what an EXPORT emits now (src/export/notes-body.js); what is
    // STORED is a block of HTML comments, because a heading is not a boundary —
    // a paper whose own text contains those words was indistinguishable from
    // the app's section — and because a heading renders, which is why the
    // rendered view had to hunt one down and hide it again.
    check(
      "its comment lands in the note's highlight-notes block",
      imported.notes.includes("<!--recall:highlight-notes-->")
        && imported.notes.includes("<!--/recall:highlight-notes-->")
        && imported.notes.includes(fixture.annotation.comment),
      imported.notes.includes(fixture.annotation.comment) ? "" : JSON.stringify(imported.notes.slice(0, 120))
    );
    check(
      "...and nothing else, on a paper whose reader has written nothing",
      imported.notes.trimStart().startsWith("<!--recall:highlight-notes-->"),
      JSON.stringify(imported.notes.slice(0, 60))
    );
  }

  // ── 2. Rendering, and the text layer ─────────────────────────────────────
  const rendered = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await settle(200);
    await api.openDocumentView({ force: true });
    // Give the observer-driven renders a moment to land, then walk every page
    // by scrolling to it — the whole point of the virtualized view is that they
    // are NOT all rendered at once, so they have to be visited.
    await settle(600);
    const out = [];
    const count = api.currentPdfPageCount();
    for (let p = 1; p <= count; p++) {
      api.scrollToDocumentPage(p, 0, { smooth: false });
      // Awaited, not slept at: the view renders on an IntersectionObserver's
      // own schedule, so a fixed wait is a race that reports a slow page as an
      // image-only one.
      await api.whenDocumentPageReady(p);
      const el = document.querySelector('.pdf-page[data-page-number="' + p + '"]');
      out.push({
        page: p,
        canvas: Boolean(el?.querySelector("canvas.pdf-canvas")),
        items: el?.querySelectorAll(".pdf-text-layer span[data-item-index]").length || 0
      });
    }
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(200);
    return { count, pages: out, outline: api.documentOutlineEntries().map((e) => ({ title: e.title, page: e.page })) };
  }`);

  check("every page renders a canvas", rendered.pages.every((p) => p.canvas),
    `${rendered.pages.filter((p) => p.canvas).length}/${rendered.count}`);

  const textless = rendered.pages.filter((p) => p.items === 0);
  check("every page renders a text layer with items in it", textless.length === 0,
    rendered.pages.map((p) => `p${p.page}:${p.items}`).join(" "));
  if (textless.length) {
    notes.push(
      `${textless.length} page(s) rendered ZERO text items (${textless.map((p) => p.page).join(", ")}). `
      + "That is a scanned PDF with no text layer: it will read fine, but it has no text selection, "
      + "no text on a highlight record and no make-card-from-text. Nothing here is broken — but nothing "
      + "in stage 4 applies to those pages either."
    );
  }
  if (fixture.linesPerPage) {
    check("the text item count matches the fixture",
      rendered.pages.every((p) => p.items === fixture.linesPerPage),
      `expected ${fixture.linesPerPage} per page`);
    check("the outline resolves every entry to its page",
      rendered.outline.length === fixture.pages && rendered.outline.every((e, i) => e.page === i + 1),
      rendered.outline.map((e) => `${e.title}→${e.page}`).join(" "));
  }

  // ── 2b. A relayout landing on a render that is still in flight ───────────
  //
  // Two zooms in one tick, which is not a contrived thing to do: it is a pinch
  // commit with the debounced refit behind it, two taps on +, or — the report
  // this check was written for — a phone's first resize landing while the pages
  // of a freshly opened document are still rasterising.
  //
  // renderPage used to turn away a request that arrived while a render was in
  // flight, and the in-flight render then correctly threw its own canvas away
  // because the scale had moved under it. Nobody was left to start the render
  // at the new scale, and the IntersectionObserver never fired again because
  // the page's intersection had not changed. Every visible page stayed on its
  // stretched stale canvas with no text layer — or, for a document being opened
  // for the first time, on a bare placeholder, which with dark page on is a
  // black rectangle where the paper should be.
  const raced = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await api.whenDocumentPageReady(1);
    const pageWidth = () => Math.round(document.querySelector('.pdf-page[data-page-number="1"]')?.getBoundingClientRect().width || 0);
    const before = pageWidth();
    api.zoomDocument(1.25);
    api.zoomDocument(1.25);
    await settle(2500);
    // Page 1 alone, and deliberately: at the zoom these two steps reach, page 2
    // is a long way below the window and relayoutDocument is RIGHT to drop it
    // back to a placeholder. The page the reader is looking at is the whole
    // claim here.
    const pages = [1].map((n) => {
      const el = document.querySelector('.pdf-page[data-page-number="' + n + '"]');
      return {
        page: n,
        canvas: Boolean(el?.querySelector("canvas.pdf-canvas")),
        stale: Boolean(el?.querySelector("canvas.pdf-canvas.is-stale")),
        placeholder: Boolean(el?.querySelector(".pdf-page-label")),
        items: el?.querySelectorAll(".pdf-text-layer span[data-item-index]").length || 0
      };
    });
    return { before, after: pageWidth(), pages };
  }`);

  check("two zooms in one tick still re-render the page",
    raced.pages.every((p) => p.canvas && !p.stale && !p.placeholder),
    raced.pages.map((p) => `p${p.page}:${p.placeholder ? "placeholder" : p.stale ? "stale" : p.canvas ? "fresh" : "empty"}`).join(" "));
  check("...with its text layer rebuilt at the scale it landed on",
    raced.pages.every((p) => p.items > 0),
    raced.pages.map((p) => `p${p.page}:${p.items}`).join(" "));
  check("...and the zoom itself took", raced.after > raced.before,
    `${raced.before}px → ${raced.after}px`);

  await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.fitDocumentToWidth();
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(400);
  }`);

  // ── 4. A selection on page 3 becomes a highlight ─────────────────────────
  const madeOn = Math.min(3, rendered.count);
  const made = await page.evaluate(`async (pageNumber) => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(pageNumber, 0, { smooth: false });
    await api.whenDocumentPageReady(pageNumber);
    const el = document.querySelector('.pdf-page[data-page-number="' + pageNumber + '"]');
    const spans = el?.querySelectorAll(".pdf-text-layer span[data-item-index]");
    if (!spans || spans.length < 3) return { error: "no text layer to select in" };
    // A known range: the whole of the page's SECOND text item. Deliberately not
    // the first — the first is the heading, and an anchor of { item: 0, ch: 0 }
    // would pass even if the item index were never read at all.
    const span = spans[1];
    const range = document.createRange();
    range.setStart(span.firstChild, 0);
    range.setEnd(span.firstChild, span.firstChild.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const capture = api.captureDocumentSelection();
    if (!capture) return { error: "captureDocumentSelection returned null" };
    const record = api.addDocumentHighlight(capture, "green");
    selection.removeAllRanges();
    await settle(250);
    return {
      capture: { anchor: capture.anchor, focus: capture.focus, text: capture.text, quads: capture.quads.length },
      record: record ? { id: record.id, color: record.color, page: record.page, quads: record.quads } : null,
      painted: el.querySelectorAll('.pdf-mark[data-highlight-id="' + (record ? record.id : "") + '"]').length,
      stored: (api.state.meta?.pdfHighlights || []).length
    };
  }`, madeOn);

  if (made.error) throw new Error(made.error);
  check("a selection captures an anchor of { page, item, ch }",
    made.capture.anchor?.page === madeOn && made.capture.anchor?.item === 1 && made.capture.anchor?.ch === 0,
    JSON.stringify(made.capture.anchor));
  check("...and an end offset at the item's last character",
    made.capture.focus?.item === 1 && made.capture.focus?.ch > 10,
    JSON.stringify(made.capture.focus));
  check("...and quads in PDF user space", made.capture.quads > 0 && Array.isArray(made.record?.quads?.[0]?.rect),
    `${made.capture.quads} quad(s) · ${JSON.stringify(made.record?.quads?.[0]?.rect?.map((n) => Math.round(n)))}`);
  check("the highlight is painted on the page", made.painted > 0, `${made.painted} mark div(s)`);
  check("...and stored on the deck", made.stored === (fixture.annotation ? 2 : 1), `${made.stored} record(s)`);

  if (fixture.linesPerPage && made.record?.quads?.[0]) {
    // Compared against where the fixture DREW that line, which is the whole
    // value of a generated fixture: the coordinates are known in advance rather
    // than being whatever the code happened to produce.
    //
    // The left edge and the baseline band are the honest comparison. The right
    // edge is not: the fixture writes text at a start position and Helvetica
    // decides how wide it ends up, so an expected x1 would be asserting a font
    // metric rather than this app's maths.
    const { x0, baseline } = fixtureLineOrigin(1);
    const got = made.record.quads[0].rect;
    const left = Math.abs(got[0] - x0) < 4;
    const band = got[1] > baseline - 6 && got[1] < baseline + 4 && got[3] > baseline && got[3] < baseline + 20;
    check("the quad lands where the fixture drew that line", left && band,
      `got [${got.map((n) => Math.round(n))}] · line starts at x=${x0}, baseline y=${baseline}`);
    check("...and is narrower than the page it sits on",
      got[2] > got[0] && got[2] < 612, `x1 = ${Math.round(got[2])}`);
    // ── Does the band actually ENCLOSE the line? ────────────────────────────
    //
    // The check above allows a band anywhere in a 10pt window around the
    // baseline, which is what let the real bug through: the text layer placed
    // every span from `baseline - 1em` down to the baseline EXACTLY, so a
    // highlight covered the ascenders and left every descender outside it — the
    // band rode high over its own words.
    //
    // The fixture is the oracle here, not the DOM: it DREW this line, so the
    // baseline is known in advance and this cannot be satisfied by two copies of
    // the same mistake agreeing with each other. In PDF user space y runs UP, so
    // rect[1] is the BOTTOM of the band and has to sit below the baseline for a
    // descender to be inside it.
    check("...and encloses the line rather than riding above it",
      got[1] < baseline - 1 && got[3] > baseline + FONT_SIZE * 0.5,
      `band ${Math.round(got[1])}..${Math.round(got[3])} around baseline ${baseline}, ${FONT_SIZE}pt text`);
  }

  // ── 4a. Highlights stored under the old geometry are repaired ────────────
  //
  // Every quad captured before the text layer knew about font ascents is a fifth
  // of an em too high, and fixing the capture cannot reach a highlight somebody
  // already made. repairDocumentHighlightQuads snaps those bands back onto the
  // glyphs as each page paints; this drives it against a record deliberately put
  // back into the old shape.
  if (made.record?.quads?.length) {
    const repaired = await page.evaluate(`async (args) => {
      const { api, settle } = window.__recall;
      const id = args.id;
      const pageNumber = args.page;
      const before = (api.state.meta.pdfHighlights || []).find((r) => r.id === id);
      const lift = (before.quads[0].rect[3] - before.quads[0].rect[1]) * 0.2;
      // A COPY of the real highlight, not the highlight itself: the reload
      // round-trip further down compares the stored quads against the ones the
      // capture produced, and a repair applied to that record would make this
      // check quietly rewrite the evidence another one depends on.
      const staleId = "hn-stale0";
      const stale = {
        ...before,
        id: staleId,
        // The old geometry, exactly: the whole band shifted up by the ascent
        // that used to be missing, and no stamp saying it has been looked at.
        quads: before.quads.map((q) => ({ ...q, rect: [q.rect[0], q.rect[1] + lift, q.rect[2], q.rect[3] + lift] }))
      };
      // ...and no stamp. addDocumentHighlight marks every record it makes as
      // current, so a copy of one is current too — which is the whole thing this
      // case has to undo to have anything to repair.
      delete stale.qv;
      api.state.meta.pdfHighlights = [...(api.state.meta.pdfHighlights || []), stale];
      // A region alongside it, also unstamped: a box dragged round a figure was
      // never measured off the text layer and must not be moved.
      const areaRect = [72, 300, 300, 400];
      api.state.meta.pdfHighlights = [...api.state.meta.pdfHighlights, {
        id: "hn-areat0", color: "blue", page: pageNumber, kind: "area",
        anchor: { page: pageNumber, item: 0, ch: 0 },
        quads: [{ page: pageNumber, rect: areaRect.slice() }], text: "", at: 1
      }];
      const staleAt = (api.state.meta.pdfHighlights || []).find((r) => r.id === staleId).at;
      const ran = api.repairDocumentHighlightQuads(pageNumber);
      await settle(80);
      const after = (api.state.meta.pdfHighlights || []).find((r) => r.id === staleId);
      // Twice, to prove it settles: the stamp is what stops a page repairing the
      // same record on every paint for the rest of the deck's life.
      const again = api.repairDocumentHighlightQuads(pageNumber);
      const settled = (api.state.meta.pdfHighlights || []).find((r) => r.id === staleId);
      const area = (api.state.meta.pdfHighlights || []).find((r) => r.id === "hn-areat0");
      const painted = document.querySelectorAll('.pdf-page[data-page-number="' + pageNumber + '"] .pdf-mark[data-highlight-id="' + staleId + '"]').length;
      return {
        ran, again, lift, painted,
        staleBottom: before.quads[0].rect[1] + lift,
        repairedBottom: after.quads[0].rect[1],
        originalBottom: before.quads[0].rect[1],
        qv: after.qv,
        atHeld: after.at === staleAt,
        settledSame: JSON.stringify(settled.quads) === JSON.stringify(after.quads),
        areaMoved: JSON.stringify(area.quads[0].rect) !== JSON.stringify(areaRect),
        areaStamped: area.qv,
        // Both scratch records go back out again. Everything after this — the
        // reload round-trip, the exports, the panel counts — counts highlights,
        // and two planted ones would fail those checks for the wrong reason.
        left: (api.state.meta.pdfHighlights = (api.state.meta.pdfHighlights || [])
          .filter((r) => r.id !== staleId && r.id !== "hn-areat0")).length
      };
    }`, { id: made.record.id, page: madeOn });

    const tenth = (n) => Math.round(n * 10) / 10;
    check("a quad stored under the old geometry is snapped back onto its line",
      repaired.ran && Math.abs(repaired.repairedBottom - repaired.originalBottom) < 1.5,
      `${tenth(repaired.staleBottom)} → ${tenth(repaired.repairedBottom)} (captured at ${tenth(repaired.originalBottom)}, lifted by ${tenth(repaired.lift)})`);
    check("...and stamped, so the next paint of the page leaves it alone",
      repaired.qv === 2 && repaired.again === false && repaired.settledSame,
      `qv=${repaired.qv} secondRun=${repaired.again} unchanged=${repaired.settledSame}`);
    check("...without moving `at`, which would out-rank a real edit made elsewhere",
      repaired.atHeld, String(repaired.atHeld));
    check("...and a region is stamped but never moved",
      repaired.areaStamped === 2 && !repaired.areaMoved,
      `qv=${repaired.areaStamped} moved=${repaired.areaMoved}`);
    check("...with the page's marks repainted against the corrected quads",
      repaired.painted > 0, `${repaired.painted} mark div(s)`);
  }

  // ── 4b. A selection that spans more than one text item ───────────────────
  //
  // "I'm seeing garbage value most of the time when I'm highlighting something
  // and then try to write a note for it."
  //
  // Section 4 above selects the whole of ONE text item, which is the one shape
  // of selection this bug cannot show: a highlight's text is range.toString()
  // over the text layer, and Range.toString() concatenates text DATA and ignores
  // elements — so with one bare <span> per item and nothing between them, every
  // selection that crossed an item boundary came back welded together. Two lines
  // of a title page arrived as "DURRANT-WHYTESimultaneous…", and that string is
  // then the highlight's name in the note, the panel, the printed page and every
  // export.
  //
  // The second half is the repair: the words of a highlight already stored that
  // way are read back off the page's own text items through the { item, ch }
  // anchors it stored alongside them, when the page paints.
  const acrossItems = await page.evaluate(`async (pageNumber) => {
    const { api, settle } = window.__recall;
    api.scrollToDocumentPage(pageNumber, 0, { smooth: false });
    await api.whenDocumentPageReady(pageNumber);
    const el = document.querySelector('.pdf-page[data-page-number="' + pageNumber + '"]');
    const spans = Array.from(el.querySelectorAll(".pdf-text-layer span[data-item-index]"));
    if (spans.length < 4) return { error: "not enough text items to span" };
    const range = document.createRange();
    range.setStart(spans[1].firstChild, 0);
    range.setEnd(spans[3].firstChild, spans[3].firstChild.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const capture = api.captureDocumentSelection();
    selection.removeAllRanges();
    if (!capture) return { error: "captureDocumentSelection returned null across items" };
    // What the three items say, and what they used to weld into.
    const parts = [spans[1], spans[2], spans[3]].map((s) => s.textContent);
    const welded = parts.join("");
    const spaced = parts.join(" ");
    const record = api.addDocumentHighlight(capture, "yellow");
    api.setDocumentHighlightNote(record.id, "A note on a passage that runs across three items.");
    await settle(150);
    // Now put the record back the way a build without separators would have
    // stored it, and make the page paint again. Nothing else is touched: the
    // anchors are the ones the capture really produced.
    const list = api.state.meta.pdfHighlights.map((r) => (r.id === record.id ? { ...r, text: welded } : r));
    api.state.meta.pdfHighlights = list;
    api.zoomDocument(1.1);
    await settle(700);
    api.fitDocumentToWidth();
    await settle(500);
    const repaired = (api.state.meta.pdfHighlights || []).find((r) => r.id === record.id);
    const notes = api.state.notes || "";
    const result = {
      captured: capture.text,
      welded,
      spaced,
      repairedText: repaired ? repaired.text : "",
      // The quoted label on the note is regenerated from the record's text, so
      // it has to have moved with it — that label is what the printed notes page
      // and the Highlights panel show.
      labelHasWelded: notes.indexOf(welded) !== -1,
      labelHasSpaced: notes.indexOf(spaced.slice(0, 40)) !== -1,
      noteKept: (api.readHighlightNotes(notes).get(record.id) || "")
    };
    api.removeDocumentHighlight(record.id);
    await settle(200);
    return result;
  }`, madeOn);

  if (acrossItems.error) throw new Error(acrossItems.error);
  check("a selection across three text items keeps the words apart",
    acrossItems.captured === acrossItems.spaced,
    `got "${acrossItems.captured.slice(0, 64)}"`);
  check("...rather than welding them into one string",
    acrossItems.captured !== acrossItems.welded && acrossItems.welded !== acrossItems.spaced,
    `welded would be "${acrossItems.welded.slice(0, 64)}"`);
  check("a highlight already stored welded repairs itself when its page paints",
    acrossItems.repairedText === acrossItems.spaced,
    `now "${acrossItems.repairedText.slice(0, 64)}"`);
  check("...taking the quoted label on its note with it",
    !acrossItems.labelHasWelded && acrossItems.labelHasSpaced);
  check("...and leaving the note itself alone",
    acrossItems.noteKept === "A note on a passage that runs across three items.",
    `"${acrossItems.noteKept}"`);

  // ── 5. Reload from IndexedDB, and repaint ────────────────────────────────
  const reloaded = await page.evaluate(`async (pageNumber, id) => {
    const { api, settle } = window.__recall;
    // A note on this highlight, for the stamp the sync merge decides by. \`at\`
    // dates the highlight and \`noteAt\` dates its note, and they are resolved
    // independently (see mergePdfHighlights) precisely so a recolour on one
    // device cannot out-rank a note written on another — which only works if
    // noteAt is actually written to disk and read back.
    api.setDocumentHighlightNote(id, "Stamped, for the sync merge.");
    const noteAtBefore = (api.state.meta?.pdfHighlights || []).find((r) => r.id === id)?.noteAt || 0;
    // Long enough to cover the 400ms autosave debounce and the async save it
    // starts. The \`api.deckAutosaveTimer\` loop below cannot be relied on for
    // this on its own: \`api\` is a flattened copy of the module namespaces, so
    // that field is the value the binding had when the harness was built and not
    // the live one. The cases before this one only ever waited it out by
    // accident, through the settles their own steps happened to need.
    await settle(900);
    // The autosave is debounced, so the highlight is in memory and not yet on
    // disk. Waited out rather than forced with a direct save: what this case is
    // actually testing is that the ORDINARY path persists a PDF deck, which is
    // exactly the thing that was silently not happening.
    for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
    await settle(300);
    // Genuinely dropped and re-read: the deck is unloaded, the document view is
    // torn down, and everything below comes back off disk.
    api.tearDownDocumentView();
    const index = api.readLocalDeckIndex();
    const deckId = index[0].id;
    api.state.meta = {};
    api.state.notes = "";
    await settle(100);
    await api.loadDeckFromLibrary(deckId);
    await settle(300);
    api.setViewMode("document");
    await api.openDocumentView({ force: true });
    api.scrollToDocumentPage(pageNumber, 0, { smooth: false });
    await api.whenDocumentPageReady(pageNumber);
    await settle(100);
    const record = (api.state.meta?.pdfHighlights || []).find((r) => r.id === id) || null;
    const painted = Array.from(document.querySelectorAll('.pdf-mark[data-highlight-id="' + id + '"]'))
      .map((el) => [Math.round(el.offsetLeft), Math.round(el.offsetTop), Math.round(el.offsetWidth), Math.round(el.offsetHeight)]);
    return {
      record: record ? { quads: record.quads, color: record.color, anchor: record.anchor, noteAt: record.noteAt } : null,
      noteAtBefore,
      noteText: (api.state.notes || "").indexOf("Stamped, for the sync merge.") !== -1,
      painted,
      rows: api.collectHighlightEntries().length
    };
  }`, madeOn, made.record.id);

  check("the highlight survives a reload from IndexedDB", Boolean(reloaded.record),
    reloaded.record ? `colour ${reloaded.record.color}` : "record is gone");
  check("...with the same quads",
    JSON.stringify(reloaded.record?.quads) === JSON.stringify(made.record.quads),
    JSON.stringify(reloaded.record?.quads?.[0]?.rect?.map((n) => Math.round(n))));
  check("...and repaints in the same place", reloaded.painted.length > 0,
    JSON.stringify(reloaded.painted[0] || null));
  check("the Highlights panel lists it",
    reloaded.rows >= (fixture.annotation ? 2 : 1), `${reloaded.rows} row(s)`);
  check("...and so does its note, with the noteAt stamp the merge decides by",
    reloaded.noteText && reloaded.record?.noteAt === reloaded.noteAtBefore && reloaded.noteAtBefore > 0,
    `noteAt ${reloaded.noteAtBefore} → ${reloaded.record?.noteAt}, note text ${reloaded.noteText ? "kept" : "LOST"}`);

  // ── 5b. The highlight/note pipeline ──────────────────────────────────────
  //
  // Four reports, four separate causes, none of which any check here could see.
  //
  //   * a fresh highlight arriving already wearing another highlight's note;
  //   * the Highlights panel scanning a different string from the one the
  //     reader is looking at, so a <mark> typed INTO a note became a row of its
  //     own and broke the exact "Go to" for every other row;
  //   * ✕ on a selection reporting "Nothing highlighted there";
  //   * and several highlights on one line each getting their own row and their
  //     own "Go to", in an order that came from when they were made rather than
  //     from where they are on the page.
  const pipeline = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const out = {};

    // ── An id that must not be re-minted ──────────────────────────────────
    //
    // Put a note entry in the fence whose id belongs to no record — what a sync
    // merge that carried the tail without the record, or a restore, leaves
    // behind — and mint two hundred ids. Not one of them may collide with it,
    // because a collision IS the reported symptom: the new highlight silently
    // adopts the orphan's note.
    const orphan = "hn-orph01";
    const before = api.state.notes;
    api.state.notes = api.setHighlightNoteInSource(before || "", orphan, "A note with no highlight.", "orphan");
    out.orphanStored = api.readHighlightNotes(api.state.notes).get(orphan) || "";
    let collided = false;
    for (let i = 0; i < 200; i += 1) if (api.freshDocumentHighlightId() === orphan) collided = true;
    out.idCollides = collided;
    api.state.notes = before;

    // ── The panel reads what the reader reads ─────────────────────────────
    //
    // A <mark> inside a highlight's own note. The pill's Highlight button
    // writes exactly this, so it is not a contrived string.
    const rowsBefore = api.collectHighlightEntries().length;
    const notesBefore = api.state.notes;
    const ids = api.documentHighlightsInReadingOrder().map((r) => r.id);
    api.state.notes = api.setHighlightNoteInSource(
      notesBefore || "", ids[0], 'A note with a <mark data-color="green">highlighted phrase</mark> in it.', "note");
    out.rowsWithMarkInNote = api.collectHighlightEntries().length;
    out.rowsBefore = rowsBefore;
    api.state.notes = notesBefore;

    // ── Two highlights on one line ────────────────────────────────────────
    //
    // Made right-to-left on purpose: reading order has to put them back in the
    // order they are READ in, which is the tiebreak that was missing — two
    // highlights with the same first-quad y fell through to Array.sort's
    // stability, which is to say to the order they were created in.
    api.setViewMode("document");
    await api.openDocumentView();
    await settle(400);
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await api.whenDocumentPageReady(1);
    const page1 = document.querySelector('.pdf-page[data-page-number="1"]');
    const spans = page1 ? Array.from(page1.querySelectorAll(".pdf-text-layer span[data-item-index]")) : [];
    out.spans = spans.length;
    // A body line, not the heading — and one long enough to cut in two.
    const line = spans.slice(1).find((sp) => (sp.firstChild?.length || 0) >= 12) || null;
    out.lineText = line ? (line.textContent || "").slice(0, 24) : "";
    const madeIds = [];
    if (line) {
      const text = line.firstChild;
      const len = text.length;
      // The right half first, then the left half.
      for (const [from, to] of [[Math.ceil(len * 0.6), len], [0, Math.floor(len * 0.4)]]) {
        const range = document.createRange();
        range.setStart(text, from);
        range.setEnd(text, to);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const capture = api.captureDocumentSelection();
        const record = capture && api.addDocumentHighlight(capture, "yellow");
        if (record) madeIds.push(record.id);
        sel.removeAllRanges();
      }
    }
    out.madeOnOneLine = madeIds.length;
    if (madeIds.length === 2) {
      const [right, left] = madeIds.map((id) => api.documentHighlightById(id));
      out.sameLine = api.sameDocumentLine(left, right);
      const order = api.documentHighlightsInReadingOrder().map((r) => r.id);
      out.leftComesFirst = order.indexOf(madeIds[1]) < order.indexOf(madeIds[0]);
      // ── ✕ over a selection that spans the whole line ────────────────────
      //
      // The old hit test read the selection's BOUNDING rect at its left edge,
      // half way down — a point in the margin for anything taller than one
      // line, and the reason this reported "Nothing highlighted there".
      const whole = document.createRange();
      whole.setStart(line.firstChild, 0);
      whole.setEnd(line.firstChild, line.firstChild.length);
      const rects = Array.from(whole.getClientRects());
      out.rectCount = rects.length;
      // ...and with something ON TOP of the words, which is the normal case:
      // the selection pill is raised over the text it was raised for. A hit
      // test would find that overlay and answer "no page here".
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:99999";
      document.body.appendChild(overlay);
      out.foundUnderOverlay = api.documentHighlightsUnderRects(rects).length;
      overlay.remove();
      out.foundUnderSelection = api.documentHighlightsUnderRects(rects).length;
      // Touched is not covered. The whole line is only partly highlighted — the
      // two runs leave a gap in the middle — so pressing a colour over it means
      // "highlight this line", not "recolour the two bits of it that are
      // already marked".
      out.coveringWholeLine = api.documentHighlightsCovering(rects).length;
      // ...and over words that ARE entirely highlighted, it is a recolour.
      const inner = document.createRange();
      inner.setStart(line.firstChild, 0);
      inner.setEnd(line.firstChild, Math.floor(line.firstChild.length * 0.4));
      out.coveringMarkedRun = api.documentHighlightsCovering(Array.from(inner.getClientRects())).length;
      madeIds.forEach((id) => api.removeDocumentHighlight(id));
      out.goneAfterRemove = madeIds.every((id) => !api.documentHighlightById(id));
    }
    return out;
  }`);

  check("a fresh highlight id never lands on an orphaned note's id",
    pipeline.orphanStored !== "" && pipeline.idCollides === false,
    pipeline.orphanStored === "" ? "the orphan entry was not written" : "200 ids, 0 collisions");
  check("a <mark> typed INTO a note is not listed as a highlight of the paper",
    pipeline.rowsWithMarkInNote === pipeline.rowsBefore,
    `${pipeline.rowsBefore} row(s) before, ${pipeline.rowsWithMarkInNote} with a mark in a note`);
  check("two highlights on one line are recognised as one line",
    pipeline.madeOnOneLine === 2 && pipeline.sameLine === true,
    `${pipeline.madeOnOneLine} made of 2 · sameLine=${pipeline.sameLine} · ${pipeline.spans} span(s) "${pipeline.lineText}"`);
  check("...and read left to right, whichever was made first",
    pipeline.leftComesFirst === true, `leftComesFirst=${pipeline.leftComesFirst}`);
  // There used to be a case here asserting that two highlights on one line
  // shared a ROW, so one "Go to" was enough for both. That merge is gone with
  // the rows: the Highlights tab is an editor now, and two annotations under one
  // line would be offered a single box to write both notes in. sameDocumentLine
  // — the geometry the merge was built on — is still asserted directly above,
  // because reading order still depends on it.
  check("a selection over the line finds the highlights under it",
    pipeline.foundUnderSelection === 2 && pipeline.foundUnderOverlay === 2,
    `${pipeline.foundUnderSelection} found over ${pipeline.rectCount} rect(s), ${pipeline.foundUnderOverlay} with something on top`);
  check("a partly-marked line is not treated as already highlighted",
    pipeline.coveringWholeLine === 0, `${pipeline.coveringWholeLine} covering record(s)`);
  check("...but a run that IS marked recolours instead of stacking a duplicate",
    pipeline.coveringMarkedRun === 1, `${pipeline.coveringMarkedRun} covering record(s)`);
  check("...and removing them actually removes them",
    pipeline.goneAfterRemove === true, `gone=${pipeline.goneAfterRemove}`);

  // ── 6. The control row, at two widths ────────────────────────────────────
  //
  // A PDF deck is the first deck with FOUR tabs, and `.view-mode-toggle` had
  // three hardcoded grid columns — so Highlights wrapped onto a second line and
  // the row grew, taking --view-toggle-h (which focus mode animates) with it.
  // The row's own height against ONE tab's is the honest test of that: a wrapped
  // row is about twice a tab tall however the tabs are styled, and no fixed
  // pixel expectation here could survive a font change.
  //
  // Beside it, the other half of the same report: the three lifted NOTES
  // controls sat on screen in Document view and all three were inert — a table
  // of contents for a note nobody is reading, a raw/rendered toggle for markdown
  // that does not exist, and the notes ⋯ menu. Asserted through
  // getComputedStyle, because they are hidden by a CSS rule and an element that
  // is merely `hidden` in the markup would pass a naive check.
  for (const [label, width] of [["desktop", 1280], ["phone", 390]]) {
    await page.call("Emulation.setDeviceMetricsOverride", {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 700
    });
    const row = await page.evaluate(`async () => {
      const { settle } = window.__recall;
      await settle(150);
      const rowEl = document.getElementById("viewModeRow");
      const tab = document.querySelector('[data-view-mode="document"]');
      const hidden = (sel) => {
        const node = document.querySelector(sel);
        return !node || getComputedStyle(node).display === "none";
      };
      return {
        rowHeight: rowEl ? rowEl.offsetHeight : 0,
        tabHeight: tab ? tab.offsetHeight : 0,
        tabTops: Array.from(document.querySelectorAll("#viewModeToggle [data-view-mode]"))
          .filter((b) => !b.hidden)
          .map((b) => Math.round(b.getBoundingClientRect().top)),
        notesTocHidden: hidden("#viewModeRow > #notesTocBtn"),
        editPillHidden: hidden("#viewModeRow > .edit-toggle-pill"),
        notesMoreHidden: hidden("#viewModeRow > .notes-head-more-btn"),
        docTocShown: !hidden("#viewModeRow > #documentTocBtn"),
        docDarkShown: !hidden("#viewModeRow > #documentDarkBtn"),
        docRegionShown: !hidden("#viewModeRow > #documentRegionBtn"),
        pagerShown: !hidden("#documentPager"),
        toolbarGone: !document.querySelector(".document-toolbar")
      };
    }`);
    const oneLine = new Set(row.tabTops).size === 1;
    // Three, not four: the Highlights tab is gone. Its cards are the
    // side-by-side pane's, which is not a view mode — see
    // src/panels/highlight-cycle.js.
    check(`the three tabs sit on one line (${label})`, oneLine && row.tabTops.length === 3,
      `${row.tabTops.length} tab(s) at y = ${[...new Set(row.tabTops)].join(", ")}`);
    check(`...and the row is one tab tall (${label})`,
      row.tabHeight > 0 && row.rowHeight < row.tabHeight * 1.8,
      `row ${row.rowHeight}px vs tab ${row.tabHeight}px`);
    check(`the inert notes controls stand down (${label})`,
      row.notesTocHidden && row.editPillHidden && row.notesMoreHidden,
      `toc=${row.notesTocHidden} pill=${row.editPillHidden} more=${row.notesMoreHidden}`);
    check(`...and the document's own controls take their place (${label})`,
      row.docTocShown && row.docDarkShown && row.docRegionShown && row.pagerShown && row.toolbarGone,
      `toc=${row.docTocShown} dark=${row.docDarkShown} region=${row.docRegionShown} pager=${row.pagerShown}`);
  }
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });

  // ── 7. A region highlight, and the same reload round-trip ────────────────
  //
  // The one thing a text selection cannot do: a figure has no text layer to drag
  // across, so captureDocumentSelection returns null over one and half the
  // content of a paper could not be highlighted at all. A region is committed
  // through the same rectToPdfQuad → addDocumentHighlight path, which is what
  // makes this worth asserting — a record whose quad is in PDF user space is one
  // that survives a zoom and a reload, and a record whose quad is in client
  // pixels would pass every check made in the session that created it.
  const region = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // The reload above went through loadDeckFromLibrary, which leaves the My
    // Decks panel on screen — and a full-screen panel over the page is exactly
    // what stops elementFromPoint finding the .pdf-page under the drag. In the
    // app that never arises (the press would land on the panel, not on
    // #documentView, so the region listener never runs at all); here the events
    // are dispatched straight at the view, so the panel has to be closed
    // explicitly or the geometry under test is somebody else's.
    api.closeMyDecksPanel();
    await settle(100);
    api.setViewMode("document");
    await api.openDocumentView();
    api.scrollToDocumentPage(2, 0, { smooth: false });
    await api.whenDocumentPageReady(2);
    await settle(150);
    const pageEl = document.querySelector('.pdf-page[data-page-number="2"]');
    if (!pageEl) return { error: "page 2 did not render" };
    const box = pageEl.getBoundingClientRect();
    // A box over the middle of the page, well clear of its edges — the geometry
    // is what is under test, not which glyphs happen to fall inside it.
    const from = { x: box.left + box.width * 0.2, y: box.top + box.height * 0.3 };
    const to = { x: box.left + box.width * 0.7, y: box.top + box.height * 0.5 };
    api.setRegionSelect(true);
    const armedClass = document.getElementById("documentStage").classList.contains("is-region-select");
    const textLayerInert = getComputedStyle(document.querySelector(".pdf-text-layer")).pointerEvents === "none";
    const view = document.getElementById("documentView");
    const send = (type, point) => view.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
      clientX: point.x, clientY: point.y
    }));
    send("pointerdown", from);
    send("pointermove", { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    const marqueeDrawn = Boolean(pageEl.querySelector(".pdf-region-marquee"));
    send("pointermove", to);
    send("pointerup", to);
    await settle(120);
    const records = api.state.meta?.pdfHighlights || [];
    const record = records.filter((r) => r.kind === "area").pop() || null;
    return {
      armedClass,
      textLayerInert,
      marqueeDrawn,
      marqueeCleared: !pageEl.querySelector(".pdf-region-marquee"),
      disarmed: !api.isRegionSelectArmed(),
      record: record ? { id: record.id, page: record.page, kind: record.kind, quads: record.quads } : null,
      painted: document.querySelectorAll('.pdf-mark[data-kind="area"]').length
    };
  }`);

  check("region select arms the surface", region.armedClass && region.textLayerInert,
    `class=${region.armedClass} textLayerInert=${region.textLayerInert}`);
  check("...and a drag draws a marquee", Boolean(region.marqueeDrawn));
  check("...which becomes an area highlight",
    region.record?.kind === "area" && region.record?.quads?.length === 1,
    region.record ? `page ${region.record.page} · ${JSON.stringify(region.record.quads[0].rect.map((n) => Math.round(n)))}` : "no record");
  check("...painted as an outline, not a tint", region.painted > 0, `${region.painted} mark div(s)`);
  check("...and the mode disarms itself after one capture",
    region.disarmed && region.marqueeCleared,
    `disarmed=${region.disarmed} marqueeCleared=${region.marqueeCleared}`);

  const regionReloaded = region.record
    ? await page.evaluate(`async (id) => {
        const { api, settle } = window.__recall;
        for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
        await settle(300);
        api.tearDownDocumentView();
        const deckId = api.readLocalDeckIndex()[0].id;
        api.state.meta = {};
        api.state.notes = "";
        await settle(100);
        await api.loadDeckFromLibrary(deckId);
        await settle(300);
        api.setViewMode("document");
        await api.openDocumentView({ force: true });
        api.scrollToDocumentPage(2, 0, { smooth: false });
        await api.whenDocumentPageReady(2);
        await settle(150);
        const record = (api.state.meta?.pdfHighlights || []).find((r) => r.id === id) || null;
        return {
          quads: record?.quads || null,
          kind: record?.kind || null,
          painted: document.querySelectorAll('.pdf-mark[data-highlight-id="' + id + '"]').length
        };
      }`, region.record.id)
    : { quads: null, kind: null, painted: 0 };

  check("the region survives a reload from IndexedDB",
    JSON.stringify(regionReloaded.quads) === JSON.stringify(region.record?.quads)
      && regionReloaded.kind === "area",
    `kind=${regionReloaded.kind}`);
  check("...and repaints on the page", regionReloaded.painted > 0,
    `${regionReloaded.painted} mark div(s)`);

  // ── 8. A note printed under the page it belongs to ───────────────────────
  //
  // The Document surface's answer to the notes view's inline highlight notes.
  // The load-bearing assertion is the LAST one: the block is a sibling of the
  // page and never a child, because a .pdf-page's box is what every highlight
  // quad on it is measured against — a note that changed the page's height would
  // move every anchor on it, silently.
  const pageNotes = region.record ? await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    api.setDocumentHighlightNote(id, "A note on the figure, for the check.");
    await settle(120);
    const pageEl = document.querySelector('.pdf-page[data-page-number="2"]');
    const heightBefore = pageEl.offsetHeight;
    const badgesBefore = pageEl.querySelectorAll(".pdf-note-badge").length;
    api.setPdfPageNotesFlag(false);
    api.togglePdfPageNotes();
    await settle(200);
    const block = document.querySelector('.pdf-page-notes[data-page-number="2"]');
    const result = {
      badgesBefore,
      on: api.isPdfPageNotesOn(),
      blockExists: Boolean(block),
      blockIsSibling: block ? block.previousElementSibling === pageEl : false,
      blockText: block ? block.textContent : "",
      heightBefore,
      heightAfter: pageEl.offsetHeight,
      // The strip is matched to the paper, not to a fixed 760px, so a wide page
      // gets a wide strip and the columns have somewhere to go. Compared to the
      // page's own width rather than to a number, since that is the promise.
      blockWidth: block ? Math.round(block.getBoundingClientRect().width) : 0,
      pageWidth: Math.round(pageEl.getBoundingClientRect().width),
      // What multicol actually did. column-width is what makes it responsive,
      // and column-span:all on the head is what keeps the head across the whole
      // strip rather than down the first column. (No backticks in here: this
      // whole function is a template literal handed to CDP.)
      columnWidth: block ? getComputedStyle(block).columnWidth : "",
      // Capped at how many notes there are, so the ONE note on this page gets
      // the whole strip rather than a 260px column with three empty ones beside
      // it. Read off the block, since it is set per block.
      columnCount: block ? getComputedStyle(block).columnCount : "",
      noteCount: block ? block.querySelectorAll(".pdf-page-note").length : 0,
      noteWidth: block ? Math.round(block.querySelector(".pdf-page-note").getBoundingClientRect().width) : 0,
      headSpan: block ? getComputedStyle(block.querySelector(".pdf-page-notes-head")).columnSpan : "",
      noteBreak: block ? getComputedStyle(block.querySelector(".pdf-page-note")).breakInside : ""
    };
    // ...and off again, so the mode does not leak into anything after this.
    api.togglePdfPageNotes();
    await settle(150);
    result.removedWhenOff = !document.querySelector(".pdf-page-notes");
    return result;
  }`, region.record.id) : null;

  if (pageNotes) {
    check("an annotated highlight gets a numbered badge", pageNotes.badgesBefore > 0,
      `${pageNotes.badgesBefore} badge(s)`);
    check("the note prints under its page", pageNotes.blockExists && pageNotes.on,
      pageNotes.blockText.slice(0, 60));
    check("...as a SIBLING of the page, leaving its height alone",
      pageNotes.blockIsSibling && pageNotes.heightBefore === pageNotes.heightAfter,
      `sibling=${pageNotes.blockIsSibling} · page ${pageNotes.heightBefore}px → ${pageNotes.heightAfter}px`);
    check("...and goes away when the mode is turned off", pageNotes.removedWhenOff);

    // ── The ROW in the menu, driven as a reader drives it ─────────────────
    //
    // Everything above calls api.togglePdfPageNotes() directly, which is why
    // "the show inline note button in the PDF is essentially dead" was true of
    // a build where every one of those assertions passed. What was dead was the
    // feedback: styles/35-notes-menu.css hides .nhm-state and turns it back on
    // only inside .notes-head-more-menu, so this row's On/Off switch had never
    // been rendered — a mode toggle that looks identical before and after.
    const modeRow = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.setPdfPageNotesFlag(false);
      api.setViewMode("document");
      await settle(300);
      document.getElementById("documentMoreBtn").click();
      await settle(200);
      const row = document.querySelector('#documentMoreMenu [data-document-action="page-notes"]');
      const stateEl = row.querySelector(".nhm-state");
      const knob = row.querySelector(".nhm-switch");
      const read = () => {
        const cs = getComputedStyle(stateEl);
        return {
          pressed: row.getAttribute("aria-pressed"),
          display: cs.display,
          direction: cs.flexDirection,
          word: getComputedStyle(stateEl, "::before").content,
          knob: getComputedStyle(knob, "::after").transform,
          width: Math.round(stateEl.getBoundingClientRect().width)
        };
      };
      const before = read();
      row.click();
      await settle(500);
      const after = read();
      const printed = document.querySelectorAll(".pdf-page-notes").length;
      // ...and off again, so the mode does not leak into the shots below.
      row.click();
      await settle(300);
      document.getElementById("documentMoreBtn").click();
      await settle(100);
      return { before, after, printed };
    }`);

    check("the ⋯ menu's 'Notes on the page' row shows a switch at all",
      modeRow.before.display !== "none" && modeRow.before.width > 20
        && modeRow.before.direction === "row",
      `display=${modeRow.before.display} direction=${modeRow.before.direction} ${modeRow.before.width}px`);
    check("...that says Off before the press and On after it",
      /off/i.test(modeRow.before.word) && /on/i.test(modeRow.after.word)
        && modeRow.before.pressed === "false" && modeRow.after.pressed === "true",
      `${modeRow.before.word} → ${modeRow.after.word}`);
    check("...with the knob actually moving",
      modeRow.before.knob !== modeRow.after.knob,
      `${modeRow.before.knob} → ${modeRow.after.knob}`);
    check("...and the press printing the notes it promised",
      modeRow.printed > 0, `${modeRow.printed} sheet(s)`);
    // The packing. One full-width row per note under a 900px page is a line of
    // text nobody wants to read and a page with five notes on it is a wall, so
    // the strip is a multicol flow now — and the three declarations below are
    // the whole of it. Asserted as computed style rather than by counting
    // columns, because how many columns fit is a function of the viewport and
    // the number of notes, and the check has one note on this page.
    check("...the strip is matched to the page, not to a fixed column",
      pageNotes.blockWidth > 0 && Math.abs(pageNotes.blockWidth - pageNotes.pageWidth) <= 2,
      `strip ${pageNotes.blockWidth}px vs page ${pageNotes.pageWidth}px`);
    check("...and packs its notes into columns",
      pageNotes.columnWidth === "260px" && pageNotes.headSpan === "all" && pageNotes.noteBreak === "avoid",
      `column-width=${pageNotes.columnWidth} head=${pageNotes.headSpan} note=${pageNotes.noteBreak}`);
    // Two halves of one promise. The cap is what stops a lone note being
    // stranded in a 260px column with three empty ones beside it; the width is
    // what says each note actually FILLS the column it was given, which
    // `width: auto` on a <button> quietly does not.
    const columns = Number(pageNotes.columnCount) || 1;
    check("...but never more columns than there are notes",
      columns === pageNotes.noteCount,
      `${pageNotes.noteCount} note(s), ${columns} column(s)`);
    check("...and each note fills the column it is in",
      pageNotes.noteWidth > (pageNotes.blockWidth / columns) * 0.75,
      `note ${pageNotes.noteWidth}px of ~${Math.round(pageNotes.blockWidth / columns)}px`);
  }

  // ── 8c. Typing into a note leaves the document where it was ─────────────
  //
  // "Whenever I'm editing the highlight the whole PDF rendering gets refreshed."
  //
  // Two mechanisms, both of them here. The editor autosaves on a 700ms debounce
  // and passes { rerender: false }, which the document side used to drop — so
  // every typing pause rebuilt the Highlights panel and every printed notes page
  // in the document. And refreshPdfPageNotes removed and re-created every block
  // whether or not its page's notes had moved.
  //
  // Asserted on NODE IDENTITY, which is the only honest way to ask "was this
  // rebuilt": a block that was torn down and built again renders the same text.
  const quiet = region.record ? await page.evaluate(`async (id) => {
    const { api, settle } = window.__recall;
    api.setPdfPageNotesFlag(false);
    api.togglePdfPageNotes();
    await settle(200);
    const pick = () => document.querySelector('.pdf-page-notes[data-page-number="2"]');
    const before = pick();
    if (!before) return { error: "no printed notes block to watch" };
    const badgeLayerBefore = document.querySelector('.pdf-page[data-page-number="2"] .pdf-badge-layer');
    // Two autosaves, exactly as typing produces them.
    api.setDocumentHighlightNote(id, "Typed once.", { rerender: false });
    await settle(80);
    api.setDocumentHighlightNote(id, "Typed twice, still typing.", { rerender: false });
    await settle(150);
    const sameAfterTyping = pick() === before;
    // ...and the one repaint the editor makes on the way out.
    api.repaintPdfPageNotes();
    await settle(150);
    const afterRepaint = pick();
    const result = {
      sameAfterTyping,
      textWhileTyping: before.textContent.indexOf("still typing") !== -1,
      rebuiltOnRepaint: afterRepaint !== before,
      textAfterRepaint: afterRepaint ? afterRepaint.textContent.indexOf("still typing") !== -1 : false,
      // A second repaint with nothing changed must not rebuild anything: that is
      // the signature guard, and it is what makes a highlight made on page 9 not
      // re-render the notes on every other page of the document.
      idleRebuilt: false,
      badgeLayerKept: false
    };
    api.repaintPdfPageNotes();
    await settle(150);
    result.idleRebuilt = pick() !== afterRepaint;
    result.badgeLayerKept = document.querySelector('.pdf-page[data-page-number="2"] .pdf-badge-layer') === badgeLayerBefore;
    api.setDocumentHighlightNote(id, "A note on the figure, for the check.");
    api.togglePdfPageNotes();
    await settle(150);
    return result;
  }`, region.record.id) : null;

  if (quiet) {
    if (quiet.error) throw new Error(quiet.error);
    check("typing into a note rebuilds nothing in the document",
      quiet.sameAfterTyping && !quiet.textWhileTyping,
      `same block=${quiet.sameAfterTyping}, block still shows the old text=${!quiet.textWhileTyping}`);
    check("...and the one repaint on close brings it up to date",
      quiet.rebuiltOnRepaint && quiet.textAfterRepaint);
    check("...while a repaint with nothing to say rebuilds nothing at all",
      !quiet.idleRebuilt && quiet.badgeLayerKept,
      `block rebuilt=${quiet.idleRebuilt}, badge layer kept=${quiet.badgeLayerKept}`);
  }

  // ── 8a. ...and the strip does not decide how wide the DOCUMENT is ────────
  //
  // "The PDFs are never by default taking 100% of width."
  //
  // .pdf-pages is `width: max-content`, because a page wider than the window has
  // to be scrollable to. max-content means the widest CHILD sizes it — and the
  // strip above is `columns: N 260px`, whose max-content contribution is
  // N × 260px plus the gaps. One page with two notes on it is 538px; one with
  // four is 1094px. On a 390px phone that made the page column two to three
  // screens wide, with the correctly-fitted page centred inside it and hanging
  // off to the right.
  //
  // Every fit-width check in this file passed while that happened, because none
  // of them ever turned the printed notes ON. This one does, and it measures the
  // page against the SCREEN — the one thing that does not move.
  const notesFit = [];
  for (const width of [360, 390]) {
    await emulatePhone(page, { width, height: 780 });
    const one = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.setViewMode("document");
      await api.openDocumentView({ force: true });
      await settle(600);
      // Four notes on ONE page, which is what it takes to reach four columns.
      // Fabricated quads rather than real selections: this is a layout question,
      // and every millimetre of it is decided by how many notes a page has.
      const made = [];
      for (let i = 0; i < 4; i += 1) {
        const y = 600 - i * 40;
        const record = api.addDocumentHighlight({
          page: 1,
          anchor: { page: 1, item: i, ch: 0 },
          focus: { page: 1, item: i, ch: 4 },
          text: "Fit width, with notes on, line " + (i + 1),
          quads: [{ page: 1, rect: [72, y - 12, 320, y] }]
        });
        if (record) made.push(record.id);
      }
      made.forEach((id, i) => api.setDocumentHighlightNote(id,
        "Note " + (i + 1) + " on page 1, long enough to want a column of its own."));
      api.setPdfPageNotesFlag(false);
      api.togglePdfPageNotes();
      await settle(400);
      const view = document.getElementById("documentView");
      const pageEl = document.querySelector('.pdf-page[data-page-number="1"]');
      const host = view.querySelector(":scope > .pdf-pages");
      const block = document.querySelector('.pdf-page-notes[data-page-number="1"]');
      const result = {
        notes: block ? block.querySelectorAll(".pdf-page-note").length : 0,
        screenWidth: Math.round(window.innerWidth),
        pageWidth: Math.round(pageEl.getBoundingClientRect().width),
        hostWidth: Math.round(host.getBoundingClientRect().width),
        blockWidth: block ? Math.round(block.getBoundingClientRect().width) : 0,
        scrollWidth: view.scrollWidth,
        clientWidth: view.clientWidth,
        // A sheet, not a strip: the paper's own shadow, and no accent rail.
        shadow: block ? getComputedStyle(block).boxShadow : "",
        // The type is a function of the paper's width, which is what stops the
        // notes reading as the document and the page as a thumbnail. Measured
        // by zooming rather than by parsing the declaration: what matters is
        // that a pinch takes the notes with it.
        typeAtFit: block ? parseFloat(getComputedStyle(block).fontSize) : 0
      };
      api.zoomDocument(1.6);
      await settle(300);
      const zoomed = document.querySelector('.pdf-page-notes[data-page-number="1"]');
      result.typeZoomedIn = zoomed ? parseFloat(getComputedStyle(zoomed).fontSize) : 0;
      result.pageZoomedIn = Math.round(document.querySelector('.pdf-page[data-page-number="1"]').getBoundingClientRect().width);
      result.blockZoomedIn = zoomed ? Math.round(zoomed.getBoundingClientRect().width) : 0;
      api.fitDocumentToWidth();
      await settle(300);
      // Put the deck back exactly as it was: the export checks below count the
      // annotated pages, and four more of them on page 1 would rewrite their
      // answers.
      api.togglePdfPageNotes();
      made.forEach((id) => api.removeDocumentHighlight(id));
      await settle(200);
      return result;
    }`);
    notesFit.push({ width, ...one });
  }

  // ── 9c-2. Selecting text on the paper, with a finger ─────────────────────
  //
  // The Document surface was the one reading surface in this app still using
  // the browser's own touch selection. src/notes/touch-selection.js opens with
  // why that is not good enough — a press gated behind the main thread, handles
  // drawn off a layout snapshot that every render invalidates, a hit-test that
  // resolves into padding at a block's edge — and every one of those is worse
  // over a PDF: the text layer is hundreds of absolutely-positioned transparent
  // spans over a canvas that repaints as the reader moves.
  //
  // Driven as real touch input through Input.dispatchTouchEvent, exactly as
  // tools/touch-selection-check.mjs drives it over a note, because a controller
  // the app implements is one a harness can actually drive.
  const touchStart = (x, y) => page.call("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
  });
  const touchMove = (x, y) => page.call("Input.dispatchTouchEvent", {
    type: "touchMove", touchPoints: [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }]
  });
  const touchEnd = () => page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  const armed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await api.whenDocumentPageReady(1);
    // Put page 1 on screen before measuring anything off it. The section above
    // scrolls the document around, and a span whose rect is off the top of the
    // viewport gives coordinates that Input.dispatchTouchEvent delivers to
    // nothing at all.
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(400);
    // ...and pick a span the point actually LANDS on: the text layer is
    // absolutely-positioned transparent boxes, and the first one on the page can
    // be a stray under the pager or clipped by the scroller's edge.
    const spans = Array.from(document.querySelectorAll('.pdf-page[data-page-number="1"] .pdf-text-layer [data-item-index]'));
    const scroller = document.getElementById("documentView").getBoundingClientRect();
    let picked = null;
    for (const span of spans) {
      const box = span.getBoundingClientRect();
      if (box.width < 80 || box.height < 6) continue;
      if (box.top < scroller.top + 40 || box.bottom > scroller.bottom - 80) continue;
      const x = Math.round(box.left + Math.min(60, box.width / 3));
      const y = Math.round(box.top + box.height / 2);
      if (document.elementFromPoint(x, y) !== span) continue;
      picked = { span, box, x, y };
      break;
    }
    if (!picked) return { error: "no reachable text layer span on page 1" };
    return {
      hasClass: document.body.classList.contains("has-touch-select"),
      userSelect: getComputedStyle(picked.span).userSelect,
      overlay: Boolean(document.querySelector(".touch-select-layer")),
      word: picked.span.textContent.trim().slice(0, 20),
      x: picked.x,
      y: picked.y,
      right: Math.round(picked.box.right),
      lineHeight: Math.round(picked.box.height)
    };
  }`);
  if (armed.error) throw new Error(armed.error);

  check("the app owns touch selection over a PDF too",
    armed.hasClass && armed.userSelect === "none" && armed.overlay,
    `has-touch-select=${armed.hasClass} user-select=${armed.userSelect} overlay=${armed.overlay}`);

  let pdfTouch = { error: "not run" };
  if (armed.hasClass) {
    await touchStart(armed.x, armed.y);
    await pause(420);            // LONG_PRESS_MS is 240
    const pressed = await page.evaluate(`() => {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      return {
        // Range.toString(), never Selection.toString(): over user-select:none
        // content the second answers "" and the first is correct, which is the
        // measurement the whole takeover rests on.
        text: range ? range.toString() : "",
        painted: Boolean(window.CSS && CSS.highlights && CSS.highlights.has("recall-touch-selection")),
        handles: Array.from(document.querySelectorAll(".touch-select-handle"))
          .filter((h) => !h.classList.contains("is-hidden")).length
      };
    }`);
    // Extend along the line, which is the gesture that used to hand the page
    // back to the browser mid-drag.
    for (let i = 1; i <= 6; i += 1) {
      await touchMove(armed.x + ((armed.right - 8 - armed.x) * i) / 6, armed.y);
      await pause(28);
    }
    await pause(120);
    const dragged = await page.evaluate(`() => {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
      return { text: range ? range.toString() : "" };
    }`);
    await touchEnd();
    await pause(250);
    pdfTouch = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      await settle(150);
      // The capture the floating pill's Highlight button acts on. Asking for it
      // is the whole chain under test: our Range, mirrored into the real
      // Selection, read back as PDF-space anchors and quads.
      const capture = api.captureDocumentSelection();
      if (!capture) return { capture: null };
      const before = (api.state.meta?.pdfHighlights || []).length;
      const record = api.addDocumentHighlight(capture, "green");
      await settle(200);
      return {
        capture: { text: capture.text, page: capture.page, quads: capture.quads.length, anchor: capture.anchor },
        added: (api.state.meta?.pdfHighlights || []).length - before,
        colour: record?.color,
        painted: document.querySelectorAll('.pdf-mark[data-highlight-id="' + record?.id + '"]').length
      };
    }`);
    pdfTouch.pressed = pressed;
    pdfTouch.dragged = dragged;
  }

  if (pdfTouch.pressed) {
    check("...a press selects a word off the page",
      pdfTouch.pressed.text.trim().length > 0 && pdfTouch.pressed.painted,
      `"${pdfTouch.pressed.text.trim().slice(0, 30)}" painted=${pdfTouch.pressed.painted}`);
    check("...with our own handles on it, not the platform's",
      pdfTouch.pressed.handles === 2, `${pdfTouch.pressed.handles} handle(s)`);
    check("...and sliding the finger extends it",
      pdfTouch.dragged.text.length > pdfTouch.pressed.text.length,
      `${pdfTouch.pressed.text.trim().length} → ${pdfTouch.dragged.text.trim().length} chars`);
    check("...which the pill can still turn into a highlight",
      Boolean(pdfTouch.capture) && pdfTouch.capture.quads > 0
        && Number.isFinite(pdfTouch.capture.anchor?.item) && pdfTouch.added === 1,
      pdfTouch.capture
        ? `page ${pdfTouch.capture.page}, ${pdfTouch.capture.quads} quad(s), item ${pdfTouch.capture.anchor?.item}`
        : "no capture");
    check("...and it paints on the page like any other",
      pdfTouch.colour === "green" && pdfTouch.painted > 0,
      `${pdfTouch.colour} · ${pdfTouch.painted} mark div(s)`);
  }

  await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // Taken back out: everything after this counts the paper's highlights, and
    // a green one made by a finger would be an extra row in all of it.
    const records = api.state.meta?.pdfHighlights || [];
    const mine = records.filter((r) => r.color === "green").map((r) => r.id);
    mine.forEach((id) => api.removeDocumentHighlight(id));
    window.getSelection()?.removeAllRanges();
    await settle(200);
  }`);

  await page.call("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });

  check("four notes on one page all print under it",
    notesFit.every((f) => f.notes === 4),
    notesFit.map((f) => `${f.width}:${f.notes} note(s)`).join(" "));
  // The regression itself. Without `contain: inline-size` on .pdf-page-notes the
  // host comes back at 1094px on both of these.
  check("...without the strip widening the page column past the screen",
    notesFit.every((f) => f.hostWidth <= f.screenWidth + 1),
    notesFit.map((f) => `${f.width}:host ${f.hostWidth}px`).join(" "));
  check("...leaving nothing to pan sideways to",
    notesFit.every((f) => f.scrollWidth <= f.clientWidth + 1),
    notesFit.map((f) => `${f.width}:${f.scrollWidth}/${f.clientWidth}`).join(" "));
  // Edge to edge, not "nearly". PDF_FIT_PADDING_NARROW is 0, so the only thing
  // between the paper and the screen is whatever the scroller's own scrollbar
  // takes.
  check("...and the page opening at the full width of the screen",
    notesFit.every((f) => f.pageWidth >= f.clientWidth - 1),
    notesFit.map((f) => `${f.width}:page ${f.pageWidth}px of ${f.clientWidth}px`).join(" "));
  // ── ...and it is a PAGE of notes, not a strip beside one ────────────────
  check("...the notes read as a sheet of the same document",
    notesFit.every((f) => f.shadow && f.shadow !== "none"),
    notesFit.map((f) => `${f.width}:${f.shadow.slice(0, 28)}`).join(" | "));
  // The other half of the report: a flat 0.86rem next to a page whose own body
  // text is about 6px at fit width read as twice the size of the document it
  // was annotating. Sized off --pdf-page-w, a zoom takes the notes with it.
  check("...with type that scales with the paper, not against it",
    notesFit.every((f) => f.pageZoomedIn > f.pageWidth && f.typeZoomedIn > f.typeAtFit),
    notesFit.map((f) => `${f.width}: page ${f.pageWidth}→${f.pageZoomedIn}px, type ${f.typeAtFit}→${f.typeZoomedIn}px`).join(" · "));
  check("...and a sheet that stays exactly as wide as its page at any zoom",
    notesFit.every((f) => Math.abs(f.blockZoomedIn - f.pageZoomedIn) <= 2),
    notesFit.map((f) => `${f.width}:sheet ${f.blockZoomedIn}px vs page ${f.pageZoomedIn}px`).join(" "));

  // ── 8b. The container the notes live in ──────────────────────────────────
  //
  // Three things this format has to get right, and every one of them is a
  // report from use rather than a hypothetical:
  //
  //   the raw editor of a MARKDOWN deck must not open full of highlight notes:
  //   the block is machine-managed text and it used to sit under the reader's
  //   own writing with nothing between them. (A document deck is the exception
  //   and gets the whole source — see section 8d, where the body is empty
  //   because the paper is the document, so slicing the block off left the
  //   editor with nothing in it at all);
  //
  //   committing that editor must not lose them. The textarea holds the body
  //   and the block is re-attached on the way back, through one choke point,
  //   because seven places copy between state.notes and the textarea and a
  //   single unrouted one deletes every note in the deck on the next keystroke;
  //
  //   and a deck still in the OLD heading form has to migrate, not vanish.
  const fence = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const before = api.state.notes;
    const editorSees = api.splitHighlightNotesTail(before).body;

    // A note written the way this app wrote them a version ago.
    const legacy = "Some prose the reader wrote.\\n\\n---\\n\\n## Highlight Notes\\n\\n"
      + "### [hn-old1] “an excerpt”\\n\\nThe note that was taken on it.\\n";
    const migrated = api.migrateLegacyHighlightNotes(legacy);
    const readBack = api.readHighlightNotes(migrated).get("hn-old1") || "";

    // ...and one that merely MENTIONS the heading, which the old parser could
    // not tell apart from its own section.
    const innocent = "# A paper about notes\\n\\n## Highlight Notes\\n\\nA section the author wrote.\\n";

    return {
      storesAFence: before.includes("<!--recall:highlight-notes-->"),
      // The whole point: what the editor is handed has none of it in it.
      editorIsClean: !editorSees.includes("<!--recall:highlight-notes-->")
        && !editorSees.includes("Highlight Notes"),
      // Split, then join, is the identity on anything this app wrote.
      roundTrips: api.joinHighlightNotesTail(editorSees, api.splitHighlightNotesTail(before).tail).trim() === before.trim(),
      // The export form is still readable prose.
      exportsAsMarkdown: api.highlightNotesSectionMarkdown(before).startsWith("## Highlight Notes"),
      migratedToFence: migrated.includes("<!--recall:highlight-notes-->") && !migrated.includes("## Highlight Notes"),
      migratedKeptTheProse: migrated.startsWith("Some prose the reader wrote."),
      migratedKeptTheNote: readBack,
      innocentUntouched: api.fenceLegacySection(innocent) === innocent,
      // What an export makes of each of the three shapes a note can be in. The
      // trap the third one is here for: readerNotesBody only knows about the
      // fence, so a note still in the heading form would have its section
      // rebuilt and appended to a body that already contained it.
      exportOfFenced: api.notesForExport(),
      exportOfLegacy: (() => {
        const held = api.state.notes;
        api.state.notes = legacy;
        const out = api.notesForExport();
        api.state.notes = held;
        return out;
      })()
    };
  }`);

  check("a highlight note is stored in a fenced block", fence.storesAFence);
  check("...which the raw editor is never handed", fence.editorIsClean);
  check("...and which split → join puts back byte for byte", fence.roundTrips);
  check("...while an export still says '## Highlight Notes'", fence.exportsAsMarkdown);
  check("an older note in the heading form migrates to the fence",
    fence.migratedToFence && fence.migratedKeptTheProse,
    `fenced=${fence.migratedToFence} prose=${fence.migratedKeptTheProse}`);
  check("...carrying its note text across",
    fence.migratedKeptTheNote === "The note that was taken on it.",
    JSON.stringify(fence.migratedKeptTheNote));
  check("...and a paper that merely CONTAINS that heading is left alone",
    fence.innocentUntouched);
  check("an export writes the section out once, from either form",
    fence.exportOfFenced.split("## Highlight Notes").length === 2
      && fence.exportOfLegacy.split("## Highlight Notes").length === 2
      && fence.exportOfLegacy.includes("The note that was taken on it."),
    `fenced=${fence.exportOfFenced.split("## Highlight Notes").length - 1}× legacy=${fence.exportOfLegacy.split("## Highlight Notes").length - 1}×`);

  // ── 8d. Where a paper's notes are written ───────────────────────────────
  //
  // "The highlighted notes are not visible anywhere as continuous, easily
  // editable text" was answered by building them into the NOTES tab, which put
  // a paper's annotations in the one tab that should hold the reader's own
  // writing. The answer is the same surface at a different address now: the
  // side-by-side pane is that continuous editor, beside the paper rather than
  // instead of it, and the Notes tab is a note.
  //
  // Both halves are asserted here, because shipping either without the other is
  // a visible regression — an editor nobody can reach, or a Notes tab that is
  // blank AND will not open its editor.
  const docNotes = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await settle(400);
    api.openHighlightSplit("document");
    await settle(600);
    const list = document.getElementById("highlightCycleBody");
    const section = list.querySelector(":scope > .hl-notes");
    const articles = Array.from(list.querySelectorAll(".hl-note[data-highlight-key]"));
    const records = api.documentHighlightsInReadingOrder();
    // Every highlight, not only the annotated ones: this is where a note is
    // WRITTEN, so one with nothing on it yet is a blank waiting for a note.
    const withNotes = articles.filter((a) => !a.querySelector(".hl-note-body").classList.contains("is-empty"));
    // Grouped by the page they are on, which is what makes a list of forty
    // passages from a paper navigable at all.
    const groups = Array.from(list.querySelectorAll(".hl-notes-group-head")).map((h) => h.textContent);
    // Press one and type into it. No popup may open: writing note after note
    // without a window per note is the whole of the request.
    const target = articles.find((a) => a.querySelector(".hl-note-body").classList.contains("is-empty")) || articles[0];
    const key = target.dataset.highlightKey;
    const id = key.replace(/^doc:/, "");
    target.querySelector(".hl-note-edit").click();
    await settle(150);
    const area = target.querySelector(".hl-note-editor .note-editor-input");
    const focused = document.activeElement === area;
    const popupOpen = Boolean(document.querySelector(".highlight-note-editor:not([hidden])"));
    area.value = "Typed straight into the pane.";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(120);
    // Still typing: nothing may have been rebuilt under the reader yet.
    const stillOpen = target.querySelector(".hl-note-editor .note-editor-input") === area;
    // A REAL blur, not a synthetic one: the in-place editor commits when the
    // focus leaves the whole editor (a toolbar press must not tear it down),
    // which is a focusout and not a non-bubbling blur Event.
    area.blur();
    await settle(400);
    const stored = api.readHighlightNotes(api.state.notes || "").get(id) || "";
    const rendered = list.querySelector('.hl-note[data-highlight-key="' + key + '"] .hl-note-body');
    // ...and the Notes tab, which is now the reader's own writing and nothing
    // else: no highlights built into it, and a raw editor with the machine-
    // managed block sliced off exactly as on any other deck.
    api.setViewMode("notes");
    await settle(400);
    const view = document.getElementById("notesView");
    const notesHasHighlights = Boolean(view.querySelector(".hl-notes"));
    const editorSees = api.rawEditorValueFor(api.state.notes || "");
    const roundTrip = api.sourceFromRawEditor(editorSees) === api.state.notes;
    // An empty note opens its editor rather than sitting there blank — the
    // regression that testing state.notes (which holds the block) would cause.
    const editorOpen = api.isNotesEditing();
    // Put it back so nothing downstream sees a note this check invented.
    api.setDocumentHighlightNote(id, "");
    await settle(150);
    api.setViewMode("document");
    await settle(200);
    return {
      hasSection: Boolean(section),
      articles: articles.length,
      records: records.length,
      annotated: withNotes.length,
      groups,
      focused, popupOpen, stillOpen, stored,
      renderedText: rendered ? rendered.textContent.trim() : "",
      notesHasHighlights,
      editorHasFence: editorSees.includes("<!--recall:highlight-notes-->"),
      editorOpen,
      roundTrip
    };
  }`);

  check("the pane lists every highlight in the paper, with its note",
    docNotes.hasSection && docNotes.articles === docNotes.records && docNotes.records > 0,
    `${docNotes.articles} entry(s) for ${docNotes.records} highlight(s), ${docNotes.annotated} written on`);
  check("...grouped by the page they are on",
    docNotes.groups.length > 0 && docNotes.groups.every((g) => /^Page \d+$/.test(g)),
    docNotes.groups.join(", ") || "no group headings");
  check("...and pressing one opens a textarea in the flow, focused, with no popup",
    docNotes.focused && docNotes.stillOpen && !docNotes.popupOpen,
    `focused=${docNotes.focused} open=${docNotes.stillOpen} popup=${docNotes.popupOpen}`);
  check("...and what is typed there is the highlight's note",
    docNotes.stored === "Typed straight into the pane."
      && docNotes.renderedText === "Typed straight into the pane.",
    `stored "${docNotes.stored}" · shown "${docNotes.renderedText}"`);
  check("the Notes tab is the reader's own writing, not the paper's annotations",
    !docNotes.notesHasHighlights && !docNotes.editorHasFence && docNotes.roundTrip,
    `highlights in notes=${docNotes.notesHasHighlights} fence in editor=${docNotes.editorHasFence} round-trips=${docNotes.roundTrip}`);
  check("...and being empty, it opens its editor rather than sitting blank",
    docNotes.editorOpen, `raw editor open=${docNotes.editorOpen}`);

  // ── 8d-ii. The number on the card is the number on the page ─────────────
  //
  // "There should be a visually apparent identifier saying which note relates to
  // which highlight." The badge pinned to a highlight and the note printed under
  // its page have carried a number for a while; the card did not, and the pane's
  // own "12 / 87" counter is a DIFFERENT sequence — position among all
  // highlights, annotated or not. Two numbers claiming to name the same
  // highlight is worse than one of them being absent, so this asserts they are
  // one sequence, taken from one function (annotatedDocumentHighlightNumbers).
  const numbering = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await settle(300);
    const records = api.documentHighlightsInReadingOrder();
    // Put back afterwards, exactly as found: the stages below this one need the
    // fixture's own annotations, and a check that quietly eats them makes the
    // next four failures look like the feature's fault.
    const was = records.map((record) => [record.id, api.documentHighlightNote(record.id)]);
    // One annotated and, deliberately, one left bare: the sequence must skip the
    // bare one rather than count it.
    api.setDocumentHighlightNote(records[0].id, "The first note.");
    api.setDocumentHighlightNote(records[1].id, "");
    await settle(200);
    api.openHighlightSplit("document");
    await settle(700);
    await api.whenDocumentPageReady(records[0].page || 1);
    await settle(400);
    const list = document.getElementById("highlightCycleBody");
    const cardNumber = (id) => {
      const card = list.querySelector('.hl-note[data-highlight-key="doc:' + id + '"]');
      return card?.querySelector(".hl-note-n")?.textContent || "";
    };
    const badgeNumber = (id) =>
      document.querySelector('.pdf-note-badge[data-highlight-id="' + id + '"]')?.textContent || "";
    const result = {
      annotatedCard: cardNumber(records[0].id),
      annotatedBadge: badgeNumber(records[0].id),
      bareCard: cardNumber(records[1].id),
      bareBadge: badgeNumber(records[1].id),
      // ...and the place label, so a card scrolled away from its group heading
      // still says which page it came from.
      where: list.querySelector('.hl-note[data-highlight-key="doc:' + records[0].id + '"] .hl-note-where')?.textContent || ""
    };
    was.forEach(([id, note]) => api.setDocumentHighlightNote(id, note));
    await settle(250);
    return result;
  }`);

  check("a card carries the same number its highlight wears on the page",
    numbering.annotatedCard !== "" && numbering.annotatedCard === numbering.annotatedBadge,
    `card "${numbering.annotatedCard}" vs badge "${numbering.annotatedBadge}"`);
  check("...and a highlight with nothing written on it is numbered in neither",
    numbering.bareCard === "" && numbering.bareBadge === "",
    `card "${numbering.bareCard}" badge "${numbering.bareBadge}"`);
  check("...and the card says which page it came from",
    /^Page \d+$/.test(numbering.where), numbering.where || "no place label");

  // ── 8d-iii. Pressing a number shows the note, not a window over it ──────
  //
  // A badge press opened a floating editor over the page. That is right when
  // there is nowhere else for the note to be, and wrong when the note is already
  // on screen beside the paper — a window covering the page it is about, showing
  // what the pane is showing anyway.
  const badgePress = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const records = api.documentHighlightsInReadingOrder();
    const was = records.map((record) => [record.id, api.documentHighlightNote(record.id)]);
    // The LAST highlight, annotated, so revealing it has to scroll the pane —
    // a card already in view would prove nothing about the reveal.
    const target = records[records.length - 1];
    records.forEach((record) => api.setDocumentHighlightNote(record.id, "Note on " + record.id + "."));
    await settle(300);
    api.setViewMode("document");
    await settle(300);
    api.openHighlightSplit("document");
    await settle(700);
    await api.whenDocumentPageReady(target.page || 1);
    api.scrollToDocumentPage(target.page || 1, 0, { smooth: false });
    await settle(600);
    const badge = document.querySelector('.pdf-note-badge[data-highlight-id="' + target.id + '"]');
    if (!badge) return { error: "no badge painted for the last highlight" };
    badge.click();
    await settle(400);
    const card = document.querySelector('#highlightCycleBody .hl-note[data-highlight-key="doc:' + target.id + '"]');
    const box = document.getElementById("highlightCycleBody").getBoundingClientRect();
    const rect = card?.getBoundingClientRect();
    const result = {
      popupOpen: Boolean(document.querySelector(".highlight-note-editor:not([hidden])")),
      current: Boolean(card?.classList.contains("is-current")),
      // Actually brought into view, not merely marked.
      inView: Boolean(rect && rect.bottom > box.top && rect.top < box.bottom),
      count: document.getElementById("highlightCycleCount")?.textContent || ""
    };
    // ...and with the pane closed the popup is still the answer.
    api.closeHighlightSplit();
    await settle(300);
    badge.click();
    await settle(400);
    result.popupWithoutPane = Boolean(document.querySelector(".highlight-note-editor:not([hidden])"));
    api.closeHighlightNoteEditor();
    await settle(200);
    was.forEach(([id, note]) => api.setDocumentHighlightNote(id, note));
    await settle(250);
    return result;
  }`);

  check("pressing a numbered badge reveals that note in the pane",
    !badgePress.error && badgePress.current && badgePress.inView && !badgePress.popupOpen,
    badgePress.error || `current=${badgePress.current} in view=${badgePress.inView} popup=${badgePress.popupOpen} counter=${badgePress.count}`);
  check("...and with no pane open, it still opens the window it always did",
    Boolean(badgePress.popupWithoutPane), String(badgePress.popupWithoutPane));

  // ── 8d-iv. Typing, then stepping away ───────────────────────────────────
  //
  // End to end through the pane: sit on a highlight, write on it, press ▶. What
  // must happen is that the text is saved on the way out and the step lands on
  // the next highlight — a commit fires notifyHighlightsChanged, which rebuilds
  // this very list, so the two halves of that sentence are not independent.
  const stepAfterTyping = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const records = api.documentHighlightsInReadingOrder();
    if (records.length < 2) return { error: "the fixture has fewer than two highlights" };
    const was = records.map((record) => [record.id, api.documentHighlightNote(record.id)]);
    records.forEach((record) => api.setDocumentHighlightNote(record.id, ""));
    await settle(250);
    api.setViewMode("document");
    await settle(300);
    api.openHighlightSplit("document");
    await settle(700);
    const list = document.getElementById("highlightCycleBody");
    const cardFor = (id) => list.querySelector('.hl-note[data-highlight-key="doc:' + id + '"]');
    // Sit on the first, open its note, and type something that MUST renumber the
    // list: this highlight becomes annotated where nothing was before.
    api.cycleToLocator({ highlightId: records[0].id });
    await settle(300);
    cardFor(records[0].id).querySelector(".hl-note-edit").click();
    await settle(250);
    const area = cardFor(records[0].id).querySelector(".hl-note-editor .note-editor-input");
    if (!area) return { error: "the card's editor did not open" };
    area.value = "Typed, then stepped away from.";
    area.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(120);
    // ▶ — which commits what was typed and then has to land on the SECOND
    // highlight, not on whatever now sits at the old index.
    document.getElementById("highlightCycleNextBtn").click();
    await settle(500);
    const result = {
      current: list.querySelector(".hl-note.is-current")?.dataset.highlightKey || "",
      wanted: "doc:" + records[1].id,
      stored: api.documentHighlightNote(records[0].id)
    };
    api.closeHighlightSplit();
    await settle(200);
    was.forEach(([id, note]) => api.setDocumentHighlightNote(id, note));
    await settle(250);
    return result;
  }`);

  check("▶ after typing into a note lands on the next highlight",
    !stepAfterTyping.error && stepAfterTyping.current === stepAfterTyping.wanted,
    stepAfterTyping.error || `landed on ${stepAfterTyping.current || "nothing"}, wanted ${stepAfterTyping.wanted}`);
  check("...and what was typed is saved on the way",
    stepAfterTyping.stored === "Typed, then stepped away from.",
    JSON.stringify(stepAfterTyping.stored));

  // ── 8e. The document panel's own list of what was marked on it ──────────
  //
  // The pane lists a paper's highlights and its deck note's separately, by the
  // surface they are on. The Document panel's contents drawer carries its own
  // Highlights section too, so a reader looking for one does not have to leave
  // the page they are on.
  const drawer = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await settle(400);
    // Through the button, not the module: the drawer is built on the way open,
    // and a check that calls the builder directly would not notice if nothing
    // called it.
    document.getElementById("documentTocBtn").click();
    await settle(400);
    const el = document.getElementById("documentOutlineDrawer");
    // ── Is the drawer actually ON SCREEN? ────────────────────────────────
    //
    // Everything below reads the drawer's DOM, and the DOM was always right:
    // rows were built, tabs were installed, jumps worked. What the reader got
    // was nothing at all, because .notes-toc-drawer is
    // 'transform: translateX(-104%); opacity: 0' until something adds .is-open
    // (styles/12-notes.css), and this drawer was only ever un-hidden — and
    // because 'width: var(--toc-width)' did not resolve outside .notes-stage,
    // so the box was shrink-wrapped as well as invisible. Two faults, both
    // invisible to a DOM query, so this is measured off getComputedStyle and
    // the box the reader would actually see.
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const seen = {
      open: el.classList.contains("is-open"),
      opacity: Number(style.opacity),
      transform: style.transform,
      width: Math.round(box.width),
      left: Math.round(box.left),
      stageWidth: Math.round(document.getElementById("documentStage").getBoundingClientRect().width)
    };
    const tabs = Array.from(el.querySelectorAll("[data-drawer-tab]")).map((t) => t.textContent);
    api.setDrawerSection(el, "highlights");
    await settle(300);
    const rows = Array.from(el.querySelectorAll(".drawer-highlight-jump")).map((row) => ({
      text: row.querySelector(".drawer-highlight-text").textContent,
      colour: row.querySelector(".drawer-highlight-chip").dataset.color,
      where: row.querySelector(".drawer-highlight-where")?.textContent || "",
      noted: Boolean(row.querySelector(".drawer-highlight-noted"))
    }));
    const records = api.documentHighlightsInReadingOrder();
    const contentsHidden = el.querySelector('[data-drawer-section="contents"]').hidden;
    // A row goes to its highlight. Not merely "the page scrolled": the flash is
    // painted on that record's own quads, which is what says the jump was exact.
    const before = api.currentDocumentPage();
    const onPage = rows.findIndex((r) => r.where && r.where !== "p. " + before);
    const index = onPage === -1 ? 0 : onPage;
    el.querySelectorAll(".drawer-highlight-jump")[index].click();
    await settle(1400);
    const wanted = Number(String(rows[index].where).replace(/[^0-9]/g, "")) || 0;
    return {
      tabs, rows, contentsHidden, seen,
      records: records.length,
      landedOn: api.currentDocumentPage(),
      wanted
    };
  }`);

  // Before anything about its contents: pressing ☰ has to put a panel on the
  // glass. "I'm clicking the hamburger in the PDF and seeing nothing" was true
  // of every build that passed every other assertion in this block.
  check("pressing the document's ☰ actually shows the drawer",
    drawer.seen.open && drawer.seen.opacity > 0.9
      && !/matrix\(1, 0, 0, 1, -?[1-9]/.test(drawer.seen.transform),
    `is-open=${drawer.seen.open} opacity=${drawer.seen.opacity} transform=${drawer.seen.transform}`);
  check("...at the width a contents drawer is meant to be",
    drawer.seen.width >= 200 && drawer.seen.width <= drawer.seen.stageWidth
      && drawer.seen.left >= -1,
    `${drawer.seen.width}px in a ${drawer.seen.stageWidth}px stage, left=${drawer.seen.left}`);

  check("the Document panel's drawer carries a Highlights section",
    drawer.tabs.join("/") === "Contents/Highlights" && drawer.contentsHidden,
    drawer.tabs.join(" / ") || "no tabs");
  check("...listing this document's own highlights, with their pages",
    drawer.rows.length === drawer.records && drawer.rows.length > 0
      && drawer.rows.every((r) => /^p\. \d+$/.test(r.where)),
    `${drawer.rows.length} row(s) for ${drawer.records} highlight(s) · ${drawer.rows.map((r) => r.where).join(", ")}`);
  check("...saying which of them carry a note",
    drawer.rows.some((r) => r.noted),
    drawer.rows.map((r) => (r.noted ? "✎" : "–")).join(""));
  check("...and a row goes to the page its highlight is on",
    drawer.wanted === 0 || drawer.landedOn === drawer.wanted,
    `wanted page ${drawer.wanted}, landed on ${drawer.landedOn}`);

  // ── 8f. The contents rows, as the reader sees them ──────────────────────
  //
  // One row class, two elements: src/notes/toc-tree.js builds a note's heading
  // as an <a href> and a PDF's page as a <button>, and .notes-toc-link reset
  // none of the user-agent button styling underneath it. So a document's
  // contents rendered as a stack of ButtonFace pills, each shrink-wrapped to
  // its own title with the text centred and the page number pushed up against
  // it — while every DOM assertion about the drawer passed, exactly as they all
  // did while it was invisible. Measured off getComputedStyle and the boxes,
  // for the same reason.
  const tocRows = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const el = document.getElementById("documentOutlineDrawer");
    // OPEN, not merely present. A closed drawer is display:none and every box in
    // it measures 0x0 — which every assertion below would then pass vacuously,
    // which is the exact failure mode this whole block exists to catch.
    if (!el.classList.contains("is-open")) document.getElementById("documentTocBtn").click();
    await settle(400);
    api.setDrawerSection(el, "contents");
    await settle(200);
    const list = document.getElementById("documentOutlineList");
    const rows = Array.from(list.querySelectorAll(".notes-toc-link"));
    if (!rows.length || !list.getBoundingClientRect().width) return { rows: rows.length, listWidth: 0 };
    const listBox = list.getBoundingClientRect();
    const widths = rows.map((row) => Math.round(row.getBoundingClientRect().width));
    // The lit row is SUPPOSED to have a background — it is the section the
    // reader is in. What must not have one is an ordinary row, which is where
    // the user agent's ButtonFace was coming through.
    const styles = rows.filter((row) => !row.classList.contains("is-active")).map((row) => {
      const s = getComputedStyle(row);
      return { align: s.textAlign, bg: s.backgroundColor, tag: row.tagName };
    });
    // The page numbers form a column only if every one of them ends at the same
    // x — which is the thing margin-left:auto could not do inside a box that
    // was only as wide as its own text.
    const pageRights = rows
      .map((row) => row.querySelector(".document-toc-page"))
      .filter(Boolean)
      .map((tail) => Math.round(tail.getBoundingClientRect().right));
    return {
      rows: rows.length,
      listWidth: Math.round(listBox.width),
      widths,
      sameWidth: new Set(widths).size === 1,
      align: styles.map((s) => s.align),
      quiet: styles.length,
      opaque: styles.filter((s) => s.bg !== "rgba(0, 0, 0, 0)" && s.bg !== "transparent" && !s.bg.endsWith(", 0)")).length,
      tags: Array.from(new Set(styles.map((s) => s.tag))),
      pageRights,
      pagesAligned: pageRights.length > 1 && new Set(pageRights).size === 1
    };
  }`);

  check("a contents row is as wide as the drawer, not as wide as its title",
    tocRows.rows > 1 && tocRows.listWidth > 100 && tocRows.sameWidth
      && tocRows.widths[0] >= tocRows.listWidth - 2,
    `${tocRows.rows} row(s) of ${new Set(tocRows.widths || []).size} different width(s) in a ${tocRows.listWidth}px list`);
  check("...with its text against the left edge",
    (tocRows.align || []).every((a) => a === "left" || a === "start"),
    Array.from(new Set(tocRows.align || [])).join(", "));
  check("...and no button of its own painted behind it",
    tocRows.quiet > 0 && tocRows.opaque === 0,
    `${tocRows.opaque} of ${tocRows.quiet} unlit row(s) carry a background · ${(tocRows.tags || []).join("/")}`);
  check("...and the page numbers line up as a column",
    tocRows.pagesAligned,
    `${(tocRows.pageRights || []).length} number(s) ending at ${Array.from(new Set(tocRows.pageRights || [])).join(", ")}`);

  // ── 8g. A contents entry whose page is not known yet ────────────────────
  //
  // Resolving an outline destination costs a worker round trip each, so only
  // the first OUTLINE_EAGER_LIMIT of them are done before the drawer paints.
  // Everything past that used to keep page 0 forever, and the click handler
  // read page 0 as "nowhere to go" and did nothing whatsoever: a book with more
  // than 300 chapters had a contents list whose bottom half was dead. This is
  // that state, made deterministically on a four-page fixture — the entry's
  // page is cleared, which is exactly what the cap left behind.
  const lateToc = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const el = document.getElementById("documentOutlineDrawer");
    const entries = api.documentOutlineEntries();
    const target = entries.findIndex((entry) => entry.page > 1 && entry.dest);
    if (target < 0) return { skipped: true };
    const wanted = entries[target].page;
    // Back to page 1, so a jump that does not happen is visible as one.
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(200);
    // Un-resolve it, exactly as the cap left it.
    entries[target].page = 0;
    entries[target].dead = false;
    api.renderDocumentOutline();
    await settle(120);
    if (!document.getElementById("documentTocBtn").getAttribute("aria-expanded") !== false) {
      // The drawer closes on a jump, so re-open it for this one.
      if (!el.classList.contains("is-open")) document.getElementById("documentTocBtn").click();
      await settle(300);
    }
    api.setDrawerSection(el, "contents");
    await settle(120);
    const row = document.querySelectorAll('#documentOutlineList .notes-toc-link')[target];
    const hadNumber = Boolean(row.querySelector(".document-toc-page"));
    row.click();
    await settle(900);
    return {
      wanted,
      hadNumber,
      landedOn: api.currentDocumentPage(),
      resolved: api.documentOutlineEntries()[target].page,
      numberNow: row.querySelector(".document-toc-page")?.textContent || ""
    };
  }`);

  if (lateToc.skipped) {
    notes.push("no outline entry past page 1 with a destination — the late-resolve check had nothing to un-resolve.");
  } else {
    check("a contents row whose page is not resolved yet still jumps",
      lateToc.landedOn === lateToc.wanted,
      `wanted page ${lateToc.wanted}, landed on ${lateToc.landedOn} (row showed a number first: ${lateToc.hadNumber})`);
    check("...and the row gets its page number from that press",
      lateToc.resolved === lateToc.wanted && lateToc.numberNow === String(lateToc.wanted),
      `entry.page=${lateToc.resolved}, row reads “${lateToc.numberNow}”`);
  }

  // A destination the file does not define is a different thing from one not
  // looked up yet, and the reader has to be able to tell: the row says so and
  // the drawer stays open, rather than closing on a jump that did not happen.
  const deadToc = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const el = document.getElementById("documentOutlineDrawer");
    if (!el.classList.contains("is-open")) document.getElementById("documentTocBtn").click();
    await settle(300);
    api.setDrawerSection(el, "contents");
    const entries = api.documentOutlineEntries();
    const target = entries.findIndex((entry) => entry.dest);
    if (target < 0) return { skipped: true };
    entries[target].page = 0;
    entries[target].dead = false;
    entries[target].dest = "no-such-destination-in-this-file";
    api.renderDocumentOutline();
    await settle(120);
    const row = document.querySelectorAll('#documentOutlineList .notes-toc-link')[target];
    row.click();
    await settle(700);
    return {
      marked: row.closest(".notes-toc-item").dataset.tocUnresolved === "true",
      stillOpen: el.classList.contains("is-open")
    };
  }`);

  if (!deadToc.skipped) {
    check("a contents entry that points nowhere says so instead of doing nothing",
      deadToc.marked, `data-toc-unresolved=${deadToc.marked}`);
    check("...and leaves the contents open, since it took you nowhere",
      deadToc.stillOpen, `drawer open=${deadToc.stillOpen}`);
  }

  // ── 8h. Side by side ────────────────────────────────────────────────────
  //
  // The page and what you wrote on it, in one panel. The layout is a second and
  // third track on .quiz-panel's own grid rather than a new container, because
  // a .pdf-page's offsetParent is .document-stage and pageOffsetTop() measures
  // against it — so the assertions below are about where the boxes ended up on
  // screen, and about the paper still being where it was.
  const split = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await settle(300);
    const drawerEl = document.getElementById("documentOutlineDrawer");
    if (!drawerEl.classList.contains("is-open")) document.getElementById("documentTocBtn").click();
    await settle(300);
    api.setDrawerSection(drawerEl, "highlights");
    await settle(200);
    const button = drawerEl.querySelector(".drawer-side-by-side");
    if (!button) return { error: "no Side by side button in the drawer" };
    button.click();
    await settle(700);
    const panel = document.querySelector(".quiz-panel");
    const stage = document.getElementById("documentStage").getBoundingClientRect();
    const pane = document.getElementById("highlightCycle").getBoundingClientRect();
    const cards = document.querySelectorAll("#highlightCycleBody .hl-note");
    const records = api.documentHighlightsInReadingOrder();
    const first = {
      count: document.getElementById("highlightCycleCount").textContent,
      page: api.currentDocumentPage(),
      current: document.querySelector("#highlightCycleBody .hl-note.is-current")?.dataset.highlightKey || ""
    };
    document.getElementById("highlightCycleNextBtn").click();
    await settle(1200);
    const second = {
      count: document.getElementById("highlightCycleCount").textContent,
      page: api.currentDocumentPage(),
      current: document.querySelector("#highlightCycleBody .hl-note.is-current")?.dataset.highlightKey || ""
    };
    // The divider, dragged left. Synthetic PointerEvents, so setPointerCapture
    // has no real pointer to capture — which the handler is written to survive.
    const divider = document.getElementById("splitDivider");
    const grip = divider.getBoundingClientRect();
    const send = (type, x) => divider.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 1, clientX: x, clientY: grip.top + grip.height / 2
    }));
    send("pointerdown", grip.left + grip.width / 2);
    send("pointermove", stage.left + (pane.right - stage.left) * 0.4);
    send("pointerup", stage.left + (pane.right - stage.left) * 0.4);
    await settle(500);
    const dragged = {
      stage: Math.round(document.getElementById("documentStage").getBoundingClientRect().width),
      pane: Math.round(document.getElementById("highlightCycle").getBoundingClientRect().width)
    };
    return {
      isSplit: panel.classList.contains("is-split"),
      side: Math.round(pane.left) >= Math.round(stage.right) - 1,
      sameRow: Math.abs(Math.round(pane.top) - Math.round(stage.top)) <= 2,
      ratio: stage.width / (stage.width + pane.width),
      cards: cards.length,
      records: records.length,
      viewMode: api.state.viewMode,
      drawerClosed: !drawerEl.classList.contains("is-open"),
      first, second, dragged
    };
  }`);

  check("the drawer's Highlights half offers side by side, and it opens",
    split.isSplit && !split.error, split.error || `is-split=${split.isSplit}, drawer closed behind it=${split.drawerClosed}`);
  check("...with the paper on the left and its highlights on the right",
    split.side && split.sameRow,
    `pane starts at the stage's right edge=${split.side}, same row=${split.sameRow}`);
  check("...at 3:2", Math.abs((split.ratio || 0) - 0.6) < 0.03, `${((split.ratio || 0) * 100).toFixed(1)}% / ${(100 - (split.ratio || 0) * 100).toFixed(1)}%`);
  check("...without leaving the Document view", split.viewMode === "document", `viewMode=${split.viewMode}`);
  check("...listing every highlight on this paper, with its note under it",
    split.cards === split.records && split.cards > 0,
    `${split.cards} card(s) for ${split.records} highlight(s)`);
  check("▶ moves to the next highlight",
    split.first?.count !== split.second?.count && split.second?.current && split.first?.current !== split.second?.current,
    `${split.first?.count} → ${split.second?.count}`);
  check("...and takes the page with it",
    split.second?.page !== undefined,
    `page ${split.first?.page} → ${split.second?.page}`);
  check("the divider resizes the two halves",
    split.dragged?.pane > split.dragged?.stage * 0.9,
    `${split.dragged?.stage}px / ${split.dragged?.pane}px after dragging to 40%`);

  // On a phone the same 3:2 has to be two ROWS: 390px halved is two thumbnails.
  // Read AFTER the viewport shrinks, so the media query has actually flipped.
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  const stacked = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    await settle(600);
    // The drag above left the split at 40%. A double-press on the divider is
    // the documented way back to 3:2, so it is exercised here and the heights
    // below are measured against the default rather than against a leftover.
    document.getElementById("splitDivider").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await settle(500);
    const stage = document.getElementById("documentStage").getBoundingClientRect();
    const pane = document.getElementById("highlightCycle").getBoundingClientRect();
    const divider = document.getElementById("splitDivider");
    return {
      stacked: Math.round(pane.top) >= Math.round(stage.bottom) - 1,
      sameColumn: Math.abs(Math.round(pane.left) - Math.round(stage.left)) <= 2,
      cursor: getComputedStyle(divider).cursor,
      orientation: divider.getAttribute("aria-orientation"),
      paneWidth: Math.round(pane.width),
      viewWidth: window.innerWidth,
      ratio: stage.height / (stage.height + pane.height),
      stageHeight: Math.round(stage.height),
      paneHeight: Math.round(pane.height),
      viewHeight: window.innerHeight
    };
  }`);
  check("on a phone the split stacks instead of halving the width",
    stacked.stacked && stacked.sameColumn && stacked.paneWidth > stacked.viewWidth * 0.7,
    `pane ${stacked.paneWidth}px wide, below the page=${stacked.stacked}, in a ${stacked.viewWidth}px viewport`);
  check("...and the divider drags the other way",
    stacked.cursor === "row-resize" && stacked.orientation === "horizontal",
    `cursor=${stacked.cursor}, aria-orientation=${stacked.orientation}`);
  // The heights, and this one has drawn blood: `fr` divides FREE space, which
  // only exists when the container's size in that axis is definite — and down
  // the page, on a phone, .quiz-panel's is not. Flexible ROW tracks in an
  // indefinite container are sized to their CONTENT, so 60fr/40fr gave the
  // paper its 22px minimum and the pane 695px of an 844px screen. The stacked
  // rows are measured lengths now (applyStackedSpace); this is what says so.
  check("...and a double-press on it comes back to 3:2 down the screen",
    Math.abs((stacked.ratio || 0) - 0.6) < 0.04
      && stacked.stageHeight > stacked.viewHeight * 0.35,
    `${stacked.stageHeight}px of paper over ${stacked.paneHeight}px of highlights `
    + `(${((stacked.ratio || 0) * 100).toFixed(1)}%) in a ${stacked.viewHeight}px viewport`);

  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });
  const splitClosed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    await settle(300);
    // Leaving for a view that is not a reading surface closes it. There is
    // nowhere else for these cards to be — the Highlights tab that used to hold
    // them is gone — so the pane going away is the whole of the answer.
    api.setViewMode("cards");
    await settle(500);
    const closed = {
      isSplit: document.querySelector(".quiz-panel").classList.contains("is-split"),
      paneHidden: document.getElementById("highlightCycle").hidden
    };
    api.setViewMode("document");
    await settle(400);
    return closed;
  }`);

  check("leaving for a view with nothing to be beside puts the split away",
    !splitClosed.isSplit && splitClosed.paneHidden,
    `is-split=${splitClosed.isSplit}, pane hidden=${splitClosed.paneHidden}`);

  // The Notes panel's own drawer does the same thing, and must list a DIFFERENT
  // set: a PDF deck's Notes tab is an ordinary note the reader may well have
  // highlighted too, and the whole point of the drawer's split is that each
  // panel lists what was marked on IT. A pane beside the note showing the
  // paper's highlights would be the bug this feature is meant to remove.
  const notesSplit = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("notes");
    await settle(400);
    // Two marks in the note body, made the way the note itself stores them.
    const q = String.fromCharCode(34);
    const body = 'A first marked <mark data-color=' + q + 'green' + q + '>phrase in the note</mark> here.\\n\\n'
      + 'And a second <mark data-color=' + q + 'blue' + q + '>phrase further down</mark> it.\\n\\n';
    api.state.notes = body + api.state.notes;
    api.renderNotesView();
    await settle(500);
    document.getElementById("notesTocBtn").click();
    await settle(400);
    const drawerEl = document.getElementById("notesTocDrawer");
    api.setDrawerSection(drawerEl, "highlights");
    await settle(250);
    const button = drawerEl.querySelector(".drawer-side-by-side");
    if (!button) return { error: "no Side by side button in the notes drawer" };
    button.click();
    await settle(700);
    const stage = document.getElementById("notesStage").getBoundingClientRect();
    const pane = document.getElementById("highlightCycle").getBoundingClientRect();
    const keys = Array.from(document.querySelectorAll("#highlightCycleBody .hl-note"))
      .map((card) => card.dataset.highlightKey);
    const out = {
      isSplit: document.querySelector(".quiz-panel").classList.contains("is-split"),
      beside: Math.round(pane.left) >= Math.round(stage.right) - 1,
      viewMode: api.state.viewMode,
      keys,
      count: document.getElementById("highlightCycleCount").textContent
    };
    api.closeHighlightSplit();
    await settle(200);
    return out;
  }`);

  check("the notes drawer opens the same split beside the note",
    notesSplit.isSplit && notesSplit.beside && notesSplit.viewMode === "notes",
    notesSplit.error || `is-split=${notesSplit.isSplit}, beside the note=${notesSplit.beside}`);
  check("...listing the NOTE's own marks, not the paper's",
    (notesSplit.keys || []).length >= 2 && (notesSplit.keys || []).every((k) => k.startsWith("mark:")),
    `${(notesSplit.keys || []).length} card(s): ${(notesSplit.keys || []).join(", ")} · ${notesSplit.count}`);

  // ── ...and moving the split between the two surfaces ────────────────────
  //
  // The split FOLLOWS the reader between Notes and Document rather than closing,
  // and the other surface's list is a different list — so the position in this
  // one means nothing over there. It was kept anyway, and because it was almost
  // always still in range, nearestCycleIndex returned it unchanged and its whole
  // "the first highlight on or after the page you are looking at" answer never
  // ran. Standing on the paper's last highlight and tapping Notes landed the
  // pane on whichever mark happened to share that index.
  //
  // The note now carries two marks (the stage above put them there) and the
  // fixture's paper carries two highlights, so "kept the index" and "started
  // afresh" are two different cards and the check can tell them apart.
  const surfaceSwap = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await settle(400);
    api.openHighlightSplit("document");
    await settle(600);
    const records = api.documentHighlightsInReadingOrder();
    if (records.length < 2) return { error: "the fixture has fewer than two document highlights" };
    // The LAST one, so the index being carried over is not 0 — which is the
    // answer a fresh start gives, and would hide the bug.
    api.cycleToLocator({ highlightId: records[records.length - 1].id });
    await settle(300);
    const from = document.querySelector("#highlightCycleBody .hl-note.is-current")?.dataset.highlightKey || "";
    api.setViewMode("notes");
    await settle(700);
    const out = {
      from,
      landed: document.querySelector("#highlightCycleBody .hl-note.is-current")?.dataset.highlightKey || "",
      count: document.getElementById("highlightCycleCount").textContent
    };
    api.closeHighlightSplit();
    await settle(200);
    return out;
  }`);

  check("moving the split to the other surface starts at the top of ITS list",
    !surfaceSwap.error && surfaceSwap.landed === "mark:0",
    surfaceSwap.error || `stood on ${surfaceSwap.from || "nothing"}, landed on ${surfaceSwap.landed || "nothing"} (${surfaceSwap.count})`);

  // ── 8c. Exporting the paper with the notes on it ─────────────────────────
  //
  // The Document view's own export, which is the one thing this surface could
  // not do: save a copy gave you the ORIGINAL file, and the Highlights tab gave
  // you a list of passages — neither is the paper you read with what you wrote
  // printed under each page.
  //
  // The print DOCUMENT is built here rather than printed: printPreparedDocument
  // opens a browser print dialog, which a headless check cannot dismiss. What is
  // asserted is everything up to that point, which is where all the risk is —
  // the pages rasterise, the right ones are chosen, and every note lands under
  // its own page.
  const docExport = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setViewMode("document");
    await settle(300);
    const all = await api.buildDocumentPrintDocument("Fixture", { annotatedOnly: false });
    const annotated = await api.buildDocumentPrintDocument("Fixture", { annotatedOnly: true });
    // split(), not a regex literal: this whole function is a template literal
    // handed to CDP, and a "/" in it is one more thing to escape correctly.
    const countOf = (html, needle) => html.split(needle).length - 1;
    const sheets = (html) => countOf(html, 'class="doc-print-sheet"');
    const images = (html) => countOf(html, '<img src="data:image');
    return {
      pageCount: api.currentPdfPageCount(),
      allSheets: sheets(all),
      allImages: images(all),
      annotatedSheets: sheets(annotated),
      annotatedPages: api.documentPrintPageCount({ annotatedOnly: true }),
      // The note under the page it belongs to, and the excerpt beside it.
      annotatedCarriesTheNote: annotated.includes("doc-print-note-body"),
      // annotatedOnly must not silently print nothing when there ARE notes.
      annotatedNotEmpty: !annotated.includes("No page of this document has a note"),
      // ...and the notes-only export is the highlights pipeline with two flags.
      notesOnly: api.buildHighlightsPrintDocument("Fixture", {
        annotatedOnly: true, groupByPage: true, includeNotes: true, includeChapter: false
      })
    };
  }`);

  check("every page of the document rasterises for the export",
    docExport.allSheets === docExport.pageCount && docExport.allImages === docExport.pageCount,
    `${docExport.allSheets} sheet(s), ${docExport.allImages} image(s) for ${docExport.pageCount} page(s)`);
  check("...and 'only the annotated pages' prints just those",
    docExport.annotatedPages > 0
      && docExport.annotatedSheets === docExport.annotatedPages
      && docExport.annotatedSheets < docExport.pageCount,
    `${docExport.annotatedSheets} of ${docExport.pageCount} page(s)`);
  check("...with the note printed under its own page",
    docExport.annotatedCarriesTheNote && docExport.annotatedNotEmpty);
  check("the notes-only export groups them by page",
    docExport.notesOnly.includes("highlight-export-page-heading")
      && !docExport.notesOnly.includes("highlight-export-page\">"),
    docExport.notesOnly.includes("highlight-export-page-heading") ? "" : "no page heading");

  // The export button beside the tabs: one control, rebuilt per view, and it
  // must never offer a Cards row from the Document view.
  const exportMenu = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const rowsFor = async (mode) => {
      api.setViewMode(mode);
      await settle(220);
      api.paintViewExportMenu();
      return Array.from(document.querySelectorAll("#viewExportMenu [data-view-export]"))
        .map((b) => b.dataset.viewExport);
    };
    const document_ = await rowsFor("document");
    const notes = await rowsFor("notes");
    const cards = await rowsFor("cards");
    api.setViewMode("document");
    await settle(220);
    const btn = document.getElementById("viewExportBtn");
    const box = btn.getBoundingClientRect();
    return { document_, notes, cards, visible: box.width > 0 && box.height > 0 };
  }`);

  check("the export button is on screen beside the tabs", exportMenu.visible);
  check("...offering the document's own exports in the Document view",
    exportMenu.document_.every((row) => row.startsWith("doc:"))
      && exportMenu.document_.includes("doc:annotated-pdf")
      && exportMenu.document_.includes("doc:original"),
    exportMenu.document_.join(", "));
  check("...the notes exports in Notes, and the card exports in Cards",
    exportMenu.notes.every((row) => row.startsWith("notes:")) && exportMenu.cards.includes("pdf"),
    `${exportMenu.notes.length} notes row(s), ${exportMenu.cards.length} cards row(s)`);

  // ── 9. The reading rail ──────────────────────────────────────────────────
  //
  // Focus mode folds the appbar and the view-mode row away, which is the point
  // of it and also takes the contents, the four views and the way back to My
  // Decks with them. The rail is what stays behind.
  //
  // It used to be asserted OFF screen while the chrome was expanded — a second
  // copy of a visible control. That is no longer the contract, and the reason is
  // the report this section now covers: the rail could never be the way IN. On a
  // landscape phone the routes into focus mode were a scroll (portrait-gated
  // until CHROME_MOBILE_QUERY was widened), Ctrl+. (no keyboard) and a row three
  // presses deep in the notes ⋯ menu. So the rail is on screen whenever a deck
  // is open, and what body.chrome-collapsed decides is how LOUD it is: the two
  // assertions are now "always there" and "louder once the chrome folds".
  //
  // Read through getComputedStyle rather than the hidden attribute, because the
  // fact is decided by a :has() rule from <body> and an element that is merely
  // present in the markup would pass a naive check.
  const rail = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const shown = () => {
      const node = document.getElementById("readingRail");
      return Boolean(node) && getComputedStyle(node).display !== "none";
    };
    const gripAlpha = () => {
      const node = document.getElementById("readingRailGrip");
      return node ? Number(getComputedStyle(node).opacity) : -1;
    };
    api.setFocusMode(false);
    await settle(150);
    const beforeFocus = shown();
    const quietAlpha = gripAlpha();
    api.setFocusMode(true);
    // The fold is a 220ms CSS transition (styles/16-mobile-reading.css:331), so
    // the row's height is only honest once it has finished — 150ms here caught
    // it mid-collapse and read as a rail that had not appeared.
    await settle(450);
    const inFocus = shown();
    const loudAlpha = gripAlpha();
    const rowFolded = document.getElementById("viewModeRow").getBoundingClientRect().height < 2;
    // The grip itself, before it is pressed. "I am not seeing anything in focus
    // mode" was a report about a control that WAS on screen and rendering — a
    // 9px, 26%-alpha stripe sitting on top of the scrollbar. So a display test
    // is not enough: it has to be a box a finger can find, and it has to be the
    // thing under its own centre rather than something painted over it.
    const grip = document.getElementById("readingRailGrip");
    const gripRect = grip.getBoundingClientRect();
    const gripBox = { w: Math.round(gripRect.width), h: Math.round(gripRect.height) };
    const hit = document.elementFromPoint(gripRect.left + gripRect.width / 2, gripRect.top + gripRect.height / 2);
    const gripIsHit = Boolean(hit) && (hit === grip || grip.contains(hit));
    // Expand it the way a reader does, and count what it offers.
    grip.click();
    await settle(120);
    const tray = document.getElementById("readingRailTray");
    const expanded = getComputedStyle(tray).display !== "none";
    const visible = () => Array.from(tray.querySelectorAll("button")).filter((b) => !b.hidden);
    const buttons = visible().length;
    // The ROWS, not every button in the tray: the head's ✕ is a button too and
    // is deliberately a glyph with no label, the same as every other close
    // control in the app.
    const rows = () => visible().filter((b) => b.classList.contains("reading-rail-btn"));
    const labelled = rows().every((b) => (b.querySelector(".rr-label")?.textContent || "").trim().length > 0);
    // Sixteen rows in a column is a list to search rather than a menu to read,
    // so each run of rows carries a heading built from its data-rail-group.
    const groups = Array.from(document.querySelectorAll("#readingRailTray .rr-group"))
      .filter((g) => !g.hidden)
      .map((g) => g.textContent.trim());
    // ...and the two mode toggles are pinned to the bottom of the scroller
    // rather than being simply the last rows of it. On a landscape phone the
    // tray scrolls, and "the last two rows of sixteen" put focus mode and full
    // screen below the fold on the one screen shape that needs them most.
    const modesStick = getComputedStyle(document.querySelector("#readingRailTray .rr-modes")).position === "sticky";
    const modesInView = (() => {
      const box = document.querySelector("#readingRailTray .rr-modes")?.getBoundingClientRect();
      const tray = document.getElementById("readingRailTray")?.getBoundingClientRect();
      if (!box || !tray) return false;
      return box.bottom <= tray.bottom + 1 && box.top >= tray.top - 1 && box.height > 0;
    })();
    // What it OFFERS, by name, rather than how many rows it happens to have.
    // A count is a test that fails every time a control is added and passes
    // every time the wrong one is removed; these are the things focus mode
    // takes away, so these are the things the rail has to give back.
    const offers = (action) => visible().some((b) => b.dataset.railAction === action);
    // What the rail owes a reader in EVERY view. "focus" was "leave-focus", a
    // one-way button: the rail could turn focus mode off and had no way to say
    // it was on, while the real toggle sits inside the row focus mode folds
    // away. Both modes are toggles here now, which is what the two assertions
    // below are about.
    const railOffers = ["decks", "contents", "style", "sync", "immersive", "focus"]
      .filter((action) => !offers(action));
    // ...and both of them SAY which way they are set — to a reader, not only to
    // a screen reader. refreshReadingRailModes has mirrored aria-pressed onto
    // these rows since the rail was written and no stylesheet ever painted it,
    // so every one of them was a working toggle that looked identical on and
    // off. Read back through getComputedStyle for exactly that reason: the
    // attribute being right is the half that was already true.
    const modeRow = (action) => visible().find((b) => b.dataset.railAction === action) || null;
    const pressedPaints = (action) => {
      const row = modeRow(action);
      if (!row) return false;
      const was = row.getAttribute("aria-pressed");
      row.setAttribute("aria-pressed", "false");
      const off = getComputedStyle(row).backgroundColor;
      row.setAttribute("aria-pressed", "true");
      const on = getComputedStyle(row).backgroundColor;
      row.setAttribute("aria-pressed", was === null ? "false" : was);
      return off !== on;
    };
    const modesAnnounce = ["focus", "immersive"].every((a) => Boolean(modeRow(a)?.hasAttribute("aria-pressed")));
    const modesPaint = ["focus", "immersive"].every(pressedPaints);
    // ...and the rows that belong to one surface. A row that does nothing when
    // pressed is worse than no row: bookmarkCurrentSpot returns without a word
    // unless the notes view is on screen, and "Fit to width" has no page to fit
    // while a markdown note is being read.
    const documentRows = ["fit-width", "dark-page", "region"];
    // "inline-notes" is not here any more: the mode that printed every
    // highlight's note into the paragraph it annotated is gone, and a note is
    // read by pressing the number on its highlight.
    const notesRows = ["bookmark-set"];
    const documentRowsInDocument = documentRows.filter((action) => !offers(action));
    const notesRowsInDocument = notesRows.filter((action) => offers(action));
    const documentIconShown = !tray.querySelector('[data-view-mode="document"]').hidden;
    const activeMatches = tray.querySelector('[data-view-mode="document"]').classList.contains("is-active");
    // The tray's own view buttons have to actually switch view.
    tray.querySelector('[data-view-mode="notes"]').click();
    await settle(250);
    const switched = api.state.viewMode;
    const collapsedAfterUse = getComputedStyle(tray).display === "none";
    // ...and the two sets have to have swapped over with the view.
    grip.click();
    await settle(120);
    const documentRowsOutside = documentRows.filter((action) => offers(action));
    document.getElementById("readingRail").dataset.expanded = "false";
    api.setViewMode("notes");
    await settle(250);
    grip.click();
    await settle(120);
    const notesRowsInNotes = notesRows.filter((action) => !offers(action));
    document.getElementById("readingRail").dataset.expanded = "false";
    // ...and leaving focus mode has to take the rail with it.
    api.setFocusMode(false);
    await settle(450);
    const afterFocus = shown();
    api.setViewMode("document");
    await settle(200);
    return { beforeFocus, inFocus, rowFolded, expanded, buttons, labelled, groups, modesStick, modesInView, quietAlpha, loudAlpha, gripBox, gripIsHit, modesAnnounce, modesPaint, documentIconShown, activeMatches, switched, collapsedAfterUse, afterFocus, railOffers, documentRowsInDocument, documentRowsOutside, notesRowsInDocument, notesRowsInNotes };
  }`);

  check("the rail is on screen whether or not focus mode is on",
    rail.beforeFocus === true && rail.inFocus === true && rail.afterFocus === true,
    `before=${rail.beforeFocus} in=${rail.inFocus} after=${rail.afterFocus}`);
  check("...quiet while the chrome is up, full strength once it folds",
    rail.quietAlpha < rail.loudAlpha && rail.quietAlpha > 0 && rail.rowFolded,
    `opacity ${rail.quietAlpha} → ${rail.loudAlpha}, rowFolded=${rail.rowFolded}`);
  check("...as a hamburger big enough to find, and hittable",
    rail.gripBox.w >= 24 && rail.gripBox.h >= 24 && rail.gripIsHit,
    `${rail.gripBox.w}×${rail.gripBox.h}px · hit=${rail.gripIsHit}`);
  check("the grip expands it into the controls focus mode took",
    rail.expanded && rail.railOffers.length === 0,
    rail.railOffers.length ? `missing: ${rail.railOffers.join(", ")}` : `${rail.buttons} row(s)`);
  check("...with both reading modes as toggles, not a one-way Leave focus",
    rail.modesAnnounce, `aria-pressed on focus + immersive = ${rail.modesAnnounce}`);
  check("...and a pressed one that actually looks pressed",
    rail.modesPaint, `the aria-pressed rule paints = ${rail.modesPaint}`);
  check("...every one of them named, not just drawn",
    rail.labelled, `labels=${rail.labelled}`);
  check("...gathered under headings rather than run together as one list",
    rail.groups.length >= 3, rail.groups.join(" · ") || "no headings");
  check("...and the two modes pinned to the bottom, never below the fold",
    rail.modesStick && rail.modesInView,
    `sticky=${rail.modesStick} inView=${rail.modesInView}`);
  check("...with the document's own controls in the document view, and only there",
    rail.documentRowsInDocument.length === 0 && rail.documentRowsOutside.length === 0,
    rail.documentRowsInDocument.length
      ? `missing in Document: ${rail.documentRowsInDocument.join(", ")}`
      : rail.documentRowsOutside.length
        ? `shown outside Document: ${rail.documentRowsOutside.join(", ")}`
        : "3 row(s), Document only");
  check("...and the bookmarks in the notes view, and only there",
    rail.notesRowsInNotes.length === 0 && rail.notesRowsInDocument.length === 0,
    rail.notesRowsInNotes.length
      ? `missing in Notes: ${rail.notesRowsInNotes.join(", ")}`
      : rail.notesRowsInDocument.length
        ? `shown over a PDF: ${rail.notesRowsInDocument.join(", ")}`
        : "Notes only");
  check("...including the Document view, lit for the view you are in",
    rail.documentIconShown && rail.activeMatches,
    `shown=${rail.documentIconShown} active=${rail.activeMatches}`);
  check("...and its view buttons switch view, then put the tray away",
    rail.switched === "notes" && rail.collapsedAfterUse,
    `viewMode=${rail.switched} collapsed=${rail.collapsedAfterUse}`);

  // ── 9b. A phone, an amoled theme, dark page, focus mode ──────────────────
  //
  // The report this exists for: open a PDF deck's Document tab on an Android
  // phone and get a full-screen black rectangle where the paper should be, and
  // it never comes back — not by scrolling, not by pinching, not by leaving the
  // tab and coming back.
  //
  // Everything above this line passed against the code that did that, which is
  // the first thing worth saying about it. Section 2b even drives two zooms in
  // one tick specifically to catch a page left blank. What none of it did was
  // run as a PHONE: emulatePhone is the mechanism, and the half that matters is
  // not the 390px — it is setTouchEmulationEnabled, because `(pointer: coarse)`
  // is the media query documentObserverLead() branches on. A "phone" check that
  // only narrows the viewport runs the desktop render path and proves nothing
  // about the device every one of these reports came from.
  //
  // Four things had to be true at once for that to be ONE report rather than
  // four, and all four are asserted below:
  //
  //   * --surface-2 was defined in no theme, so .document-scroll's
  //     `background: var(--surface-2, var(--bg))` always took the fallback —
  //     and three themes set --bg to #000000. An empty scroller was a pure
  //     black panel;
  //   * `.is-pdf-inverted .pdf-page` was #111, so a page that had not drawn was
  //     a black rectangle inside it, at a contrast ratio of 1.10;
  //   * the only thing that ever STARTED a page's first render was an
  //     IntersectionObserver whose root is that scroller, and an
  //     IntersectionObserver speaks only on a CHANGE — so a report of "nothing
  //     is intersecting", made against a scroller that had not been laid out
  //     yet, was final;
  //   * and every recovery went through one expression, `isPageNearViewport(n)
  //     && renderPage(n)`, either half of which could be a permanent no.
  //
  // The canvas is SAMPLED, not counted. getContext("2d", { alpha: false })
  // initialises a bitmap to opaque black, so an element test passes for a
  // canvas that was allocated and never painted — which is this exact failure
  // wearing the shape of a pass.
  await emulatePhone(page, { width: 390, height: 844 });

  const onPhone = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // The reader's actual configuration, set the way the app persists it so
    // nothing here is a special case the app never otherwise reaches.
    try {
      localStorage.setItem("recall:pdfInvert", "1");
      localStorage.setItem("recall:focusMode", "1");
    } catch (e) { /* the calls below still set the live state */ }
    document.documentElement.dataset.theme = "dark-amoled";
    api.applyPdfInvert(true);
    api.setFocusMode(true);
    // The fold is a 220ms transition and it CHANGES THE SCROLLER'S HEIGHT,
    // which is the geometry every assertion below depends on.
    await settle(450);

    const coarse = window.matchMedia("(pointer: coarse)").matches;

    // Opened the way the app opens it: from another view, with the stage
    // hidden, and with openDocumentView called in the same tick the stage is
    // un-hidden — which is what setViewMode does, and is why the scroller can
    // be measured at zero height.
    api.tearDownDocumentView();
    api.setViewMode("cards");
    await settle(200);
    api.setViewMode("document");
    const opened = await api.openDocumentView({ force: true });
    await settle(600);
    // ...and at page 1, which is the page every assertion below is about.
    // Earlier sections leave a reading position on page 3, and an open resumes
    // to it — correctly. A phone's render lead is half a viewport either side
    // (documentObserverLead), so page 1 is genuinely not due to be rasterised
    // from there, and asserting that it has been would be asserting that the
    // virtualisation does not work.
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(1500);

    const view = document.getElementById("documentView");
    const pageEl = document.querySelector('.pdf-page[data-page-number="1"]');
    const canvas = pageEl && pageEl.querySelector("canvas.pdf-canvas");

    // What the reader can actually tell apart. Not "are these two colours
    // different" — #000 and #111 ARE different, and are the same rectangle on
    // an OLED screen — but a contrast ratio, which is the number that says
    // whether there is an edge there at all.
    const channel = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const rgb = (value) => (String(value).match(/[\\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    const lum = (value) => { const c = rgb(value); return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    // The label's colour is an rgba OVER the page, so it has to be composited
    // before it can be compared to it: getComputedStyle reports what was
    // authored, not what was painted.
    const over = (fg, bg) => {
      const f = rgb(fg), b = rgb(bg);
      const a = Number((String(fg).match(/[\\d.]+/g) || [])[3] ?? 1);
      return "rgb(" + f.map((v, i) => Math.round(v * a + b[i] * (1 - a))).join(",") + ")";
    };

    const mount = getComputedStyle(view).backgroundColor;
    const paper = pageEl ? getComputedStyle(pageEl).backgroundColor : "";
    // The placeholder's page number, measured off a PROBE rather than off
    // whichever page happens to still be one. On a four-page fixture at phone
    // width every page can have rasterised by now, and renderPage removes the
    // label as it appends the canvas — so reading a real page's label is a race
    // this check would lose intermittently and silently. The probe is the same
    // two elements the placeholder is built from, so it resolves the same
    // cascade; it is never in the layout long enough to be seen.
    const probePage = document.createElement("div");
    probePage.className = "pdf-page";
    const probeLabel = document.createElement("span");
    probeLabel.className = "pdf-page-label";
    probeLabel.textContent = "1";
    probePage.appendChild(probeLabel);
    view.appendChild(probePage);
    const labelColor = getComputedStyle(probeLabel).color;
    const probePaper = getComputedStyle(probePage).backgroundColor;
    probePage.remove();

    // The bitmap itself. Downscaled onto a scratch canvas in one drawImage, so
    // this reads 768 pixels rather than a million, and reported as a spread of
    // luminance: a canvas that was allocated and never painted is one value
    // repeated, whatever that value happens to be.
    let darkest = -1, lightest = -1;
    if (canvas && canvas.width && canvas.height) {
      const scratch = document.createElement("canvas");
      scratch.width = 24;
      scratch.height = 32;
      const ctx = scratch.getContext("2d");
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 24, 32);
      const data = ctx.getImageData(0, 0, 24, 32).data;
      darkest = 255; lightest = 0;
      for (let i = 0; i < data.length; i += 4) {
        const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (y < darkest) darkest = y;
        if (y > lightest) lightest = y;
      }
    }

    return {
      coarse,
      opened,
      surfaceToken: getComputedStyle(document.documentElement).getPropertyValue("--surface-2").trim(),
      pages: document.querySelectorAll(".pdf-page").length,
      pageCount: api.currentPdfPageCount(),
      scrollerHeight: Math.round(view.getBoundingClientRect().height),
      scrollerWidth: Math.round(view.getBoundingClientRect().width),
      pageBox: pageEl ? Math.round(pageEl.getBoundingClientRect().width) + "x" + Math.round(pageEl.getBoundingClientRect().height) : "none",
      hasCanvas: Boolean(canvas),
      isStale: Boolean(canvas && canvas.classList.contains("is-stale")),
      placeholder: Boolean(pageEl && pageEl.querySelector(".pdf-page-label")),
      items: pageEl ? pageEl.querySelectorAll(".pdf-text-layer span[data-item-index]").length : 0,
      mount, paper, labelColor, probePaper,
      mountVsPaper: paper ? ratio(mount, paper) : 0,
      labelVsPaper: labelColor && probePaper ? ratio(over(labelColor, probePaper), probePaper) : 0,
      darkest: Math.round(darkest),
      lightest: Math.round(lightest)
    };
  }`);

  check("the phone check is actually running as a phone",
    onPhone.coarse === true, `(pointer: coarse) = ${onPhone.coarse}`);
  check("a phone opens the document onto pages, not an empty scroller",
    onPhone.opened === true && onPhone.pages === onPhone.pageCount && onPhone.scrollerHeight > 100,
    `opened=${onPhone.opened} · ${onPhone.pages}/${onPhone.pageCount} page(s) · scroller ${onPhone.scrollerHeight}px`);
  check("...and page 1 carries a fresh canvas, not a placeholder",
    onPhone.hasCanvas && !onPhone.isStale && !onPhone.placeholder,
    `${onPhone.placeholder ? "p1:placeholder" : onPhone.isStale ? "p1:stale" : onPhone.hasCanvas ? "p1:fresh" : "p1:empty"} · page ${onPhone.pageBox} in a ${onPhone.scrollerWidth}px scroller`);
  check("...with a page actually painted on it, not an empty bitmap",
    onPhone.lightest - onPhone.darkest >= 40,
    `luminance ${onPhone.darkest}..${onPhone.lightest}`);
  check("...and its text layer built at the scale it landed on",
    onPhone.items > 0, `p1:${onPhone.items} item(s)`);
  check("--surface-2 resolves to a colour rather than falling through to --bg",
    onPhone.surfaceToken !== "", onPhone.surfaceToken || "(undefined — the fallback wins)");
  // 1.4 is not a decoration threshold. #000 against #111 is 1.10: two
  // rectangles nobody can tell apart on an OLED phone, which is why "the
  // document did not open" and "the page has not drawn yet" arrived as one
  // report and took two attempts to tell apart.
  check("...so an empty scroller is not the same black as an undrawn page",
    onPhone.mountVsPaper >= 1.4,
    `${onPhone.mount} vs ${onPhone.paper} = ${onPhone.mountVsPaper.toFixed(2)}:1`);
  check("...and the placeholder's page number is legible on it",
    onPhone.labelVsPaper >= 3,
    `${onPhone.labelColor} on ${onPhone.probePaper} = ${onPhone.labelVsPaper.toFixed(2)}:1`);

  // ── 9c. A first render that never answers ────────────────────────────────
  //
  // renderPage's in-flight guard — "a render is already going, remember the
  // request and let that one finish" — is right until the render it is waiting
  // for never finishes, and then it is a dead end. A pdf.js render is a round
  // trip to a worker, and a worker on a phone is a thing the OS can kill
  // without telling anyone: the promise neither resolves nor rejects,
  // entry.task stays truthy, and every later request is turned away by that
  // guard. The rerender flag those requests set is only ever read from inside
  // the finally() that is never going to run.
  //
  // That is "it never comes back" as a matter of control flow, and it is why
  // the previous fix for this symptom did not land: that change altered what
  // happens UNDER the guard and left the guard.
  //
  // Simulated by hanging exactly one getPage, once, and then doing the three
  // things the reader actually did.
  const hung = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const doc = api.currentPdfDocument();
    const real = doc.getPage.bind(doc);
    let hangs = 1;
    doc.getPage = (n) => (n === 1 && hangs-- > 0) ? new Promise(() => {}) : real(n);

    // A zoom, which is a real scale change, so page 1 keeps its old canvas as
    // the stretched is-stale one while a fresh render is asked for — and that
    // ask is the one that hangs. Precisely the shape the previous fix for this
    // symptom described and did not cure: a page that had rendered before keeps
    // the stretched stale canvas forever, with no text layer and no highlights.
    //
    // So stuck asks for a FRESH canvas, not for any canvas. A stale one is
    // present throughout and is exactly what the reader is complaining about.
    const fresh = () => {
      const c = document.querySelector('.pdf-page[data-page-number="1"] canvas.pdf-canvas');
      return Boolean(c && !c.classList.contains("is-stale"));
    };
    api.zoomDocument(1.25);
    await settle(600);
    const stuck = !fresh();

    // Everything the reader tried, in the order they tried it.
    api.scrollToDocumentPage(3, 0, { smooth: false });
    await settle(300);
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(300);
    api.fitDocumentToWidth();
    await settle(300);
    api.setViewMode("cards");
    await settle(150);
    api.setViewMode("document");
    await api.openDocumentView();
    // Long enough for the render deadline to release the pinned entry. Nothing
    // shorter can pass: the whole point is that no amount of READER action
    // reaches a render that never settles, so what rescues it is a timer.
    await settle(Math.max(2000, api.PDF_RENDER_DEADLINE_MS + 3000));

    const el = document.querySelector('.pdf-page[data-page-number="1"]');
    doc.getPage = real;
    return {
      stuck,
      canvas: fresh(),
      placeholder: Boolean(el && el.querySelector(".pdf-page-label")),
      error: Boolean(el && el.querySelector(".pdf-page-label.is-error"))
    };
  }`);

  check("a first render that never answers does leave the page blank at first",
    hung.stuck === true, `stuck=${hung.stuck}`);
  check("...and the page comes back anyway, without the reader doing anything",
    hung.canvas && !hung.placeholder,
    hung.error ? "the page says it could not be drawn"
      : hung.placeholder ? "p1:placeholder — still stuck"
        : hung.canvas ? "p1:fresh" : "p1:empty");

  // Back to the desktop viewport and the ordinary preferences, so section 10
  // and the screenshot are not taken on a phone in focus mode with dark page on.
  await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setFocusMode(false);
    api.applyPdfInvert(false);
    try {
      localStorage.setItem("recall:pdfInvert", "0");
      localStorage.setItem("recall:focusMode", "0");
    } catch (e) { /* the live state above is what the rest of the run reads */ }
    await settle(450);
  }`);
  await page.call("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
  });

  // ── 9d. A wide document, on a phone ──────────────────────────────────────
  //
  // "It doesn't start at 100% width, and I can't pan or zoom out."
  //
  // Every fixture above is Letter portrait, 612pt — which on any phone fits
  // across at a scale comfortably above the floor, so no check here has ever
  // asked whether fit-width can actually reach the width it needs. A slide deck
  // can not: a 1280pt 16:9 slide on a 390px screen wants 0.267 and the floor
  // was a flat 0.4, so the page opened 512px wide in a 342px scroller. Pressing
  // − or pinching in hit the same floor, and "Fit to width" recomputed the same
  // clamped number — a page the reader could not fit, could not zoom out of,
  // and could only pan around.
  //
  // Asserted at three widths, because the failure is a function of the ratio
  // between the page and the screen and picking one width is picking one answer.
  if (!OWN_PDF) {
    const wide = buildFixturePdf({ pages: 2, annotate: false, width: 1280, height: 720 });
    const wideResult = await page.evaluate(`async (bytes) => {
      const { api, settle } = window.__recall;
      const before = api.readLocalDeckIndex().map((m) => m.id);
      const file = new File([new Uint8Array(bytes)], "slides.pdf", { type: "application/pdf" });
      await api.importPdfFile(file, null);
      await settle(400);
      const index = api.readLocalDeckIndex();
      const entry = index.find((m) => !before.includes(m.id));
      if (!entry) return { error: "no deck was created for the wide PDF" };
      for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
      await api.loadDeckFromLibrary(entry.id);
      // loadDeckFromLibrary reaches openDocumentView through setViewMode and
      // does not await it, so ask for the document directly before measuring.
      api.setViewMode("document");
      await api.openDocumentView({ force: true });
      await settle(400);
      // Measured off the rendered page rather than off api.openPdf: the check's
      // api object is a flattened snapshot of each module's exports, so a
      // binding the module reassigns later — which openPdf is, on every open —
      // is a stale null here forever. The page's own proportions prove the same
      // thing, and prove it about what actually reached the screen.
      const el1 = document.querySelector('.pdf-page[data-page-number="1"]');
      const box = el1 ? el1.getBoundingClientRect() : null;
      return { deckId: entry.id, ratio: box && box.height ? box.width / box.height : 0 };
    }`, [...wide.bytes]);
    if (wideResult.error) throw new Error(wideResult.error);

    check("a 16:9 slide deck opens as a wide document",
      Math.abs(wideResult.ratio - 1280 / 720) < 0.02,
      `page is ${wideResult.ratio.toFixed(3)}:1 (16:9 is ${(1280 / 720).toFixed(3)})`);

    const fits = [];
    for (const width of [360, 390, 430]) {
      await emulatePhone(page, { width, height: 780 });
      const one = await page.evaluate(`async () => {
        const { api, settle } = window.__recall;
        api.setViewMode("document");
        await api.openDocumentView({ force: true });
        await settle(900);
        const view = document.getElementById("documentView");
        const pageEl = document.querySelector('.pdf-page[data-page-number="1"]');
        const host = view.querySelector(":scope > .pdf-pages");
        // Zoom all the way out from wherever it landed, then fit again — both
        // routes have to reach a page that fits, because "Fit to width" doing
        // nothing was half of the report.
        api.zoomDocument(0.8);
        await settle(300);
        const afterZoomOut = Math.round(document.querySelector('.pdf-page[data-page-number="1"]').getBoundingClientRect().width);
        api.fitDocumentToWidth();
        await settle(400);
        const refitted = document.querySelector('.pdf-page[data-page-number="1"]');
        return {
          // The WINDOW, not the scroller. Measuring the page against its own
          // scroller is the assertion that cannot fail: without min-width: 0 a
          // wide page widens the scroller to fit itself, so the two matched
          // exactly while the page hung half off the side of the screen and the
          // whole app scrolled sideways. The screen is the thing that does not
          // move.
          screenWidth: Math.round(window.innerWidth),
          viewWidth: Math.round(view.clientWidth),
          pageWidth: Math.round(pageEl.getBoundingClientRect().width),
          refittedWidth: Math.round(refitted.getBoundingClientRect().width),
          afterZoomOut,
          scrollWidth: view.scrollWidth,
          clientWidth: view.clientWidth,
          // Nothing may be left transforming the page host: a stuck pinch
          // transform is a page that looks zoomed in and cannot be panned to,
          // because a transform moves the pixels and not the scroll extents.
          hostTransform: host ? getComputedStyle(host).transform : "none"
        };
      }`);
      fits.push({ width, ...one });
    }

    fits.forEach(({ width, screenWidth, viewWidth, pageWidth }) => {
      check(`...and fits across a ${width}px phone on open`,
        pageWidth <= screenWidth && viewWidth <= screenWidth,
        `page ${pageWidth}px, scroller ${viewWidth}px, screen ${screenWidth}px`);
    });
    check("...with no horizontal panning left to do at fit width",
      fits.every((f) => f.scrollWidth <= f.clientWidth + 1),
      fits.map((f) => `${f.width}:${f.scrollWidth}/${f.clientWidth}`).join(" "));
    check("...and zooming out actually zooms out",
      fits.every((f) => f.afterZoomOut < f.pageWidth),
      fits.map((f) => `${f.width}:${f.pageWidth}\u2192${f.afterZoomOut}`).join(" "));
    check("...and Fit to width brings it back to the width",
      fits.every((f) => f.refittedWidth <= f.screenWidth && f.refittedWidth > f.screenWidth * 0.8),
      fits.map((f) => `${f.width}:${f.refittedWidth}/${f.screenWidth}`).join(" "));
    check("...leaving nothing transforming the page host",
      fits.every((f) => f.hostTransform === "none" || f.hostTransform === "matrix(1, 0, 0, 1, 0, 0)"),
      fits.map((f) => f.hostTransform).join(" | "));

    await page.call("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 });
    await page.call("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 900, deviceScaleFactor: 1, mobile: false
    });
  }

  // ── 10. A PDF with no annotations in it ──────────────────────────────────
  //
  // The ordinary case, and the one every assertion above manages to miss. A
  // file that arrives WITH highlights gives its deck a non-empty note (the
  // imported comments land in "## Highlight Notes"), and it was the empty note
  // that broke everything: "a deck is cards or notes" made a freshly imported
  // paper indistinguishable from an empty deck, so it never autosaved and
  // loadDeckSnapshot threw "No cards in flashcard JSON" when it was opened —
  // reported to the reader as "That saved deck is corrupted and could not be
  // loaded", on a deck that was entirely intact.
  //
  // So this imports a second, un-annotated copy and does the one thing a reader
  // does next: opens it.
  if (!OWN_PDF) {
    const plain = buildFixturePdf({ annotate: false });
    const plainResult = await page.evaluate(`async (bytes) => {
      const { api, settle } = window.__recall;
      const before = api.readLocalDeckIndex().map((m) => m.id);
      const file = new File([new Uint8Array(bytes)], "unannotated.pdf", { type: "application/pdf" });
      await api.importPdfFile(file, null);
      await settle(400);
      const index = api.readLocalDeckIndex();
      const entry = index.find((m) => !before.includes(m.id));
      if (!entry) return { error: "no deck was created for the un-annotated PDF" };
      // Let the ordinary debounced autosave land, then open it the way a reader
      // would — through loadDeckFromLibrary, which is where the throw surfaced.
      for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
      await settle(400);
      let loadError = "";
      const loaded = await api.loadDeckFromLibrary(entry.id).catch((e) => { loadError = String(e?.message || e); return false; });
      await settle(400);
      return {
        notes: api.state.notes || "",
        loaded,
        loadError,
        hasPdfMeta: Boolean(api.state.meta?.pdf),
        viewMode: api.state.viewMode,
        tabHidden: document.querySelector('[data-view-mode="document"]')?.hidden,
        status: document.getElementById("statusBar")?.textContent || ""
      };
    }`, Array.from(plain.bytes));

    if (plainResult.error) throw new Error(plainResult.error);
    check("a PDF with no annotations imports to a deck with an empty note",
      plainResult.notes.trim() === "", `${plainResult.notes.length} chars of note`);
    check("...and that deck OPENS rather than reading as corrupted",
      plainResult.loaded === true && !plainResult.loadError,
      plainResult.loadError || plainResult.status || "");
    check("...with its meta.pdf intact", plainResult.hasPdfMeta === true, String(plainResult.hasPdfMeta));
    check("...and its Document tab on screen",
      plainResult.viewMode === "document" && plainResult.tabHidden === false,
      `viewMode=${plainResult.viewMode} tabHidden=${plainResult.tabHidden}`);
  }

  // ── 12. A contents for a PDF that carries none ──────────────────────────
  //
  // The outline dictionary is what a well-made book has and what almost no
  // PAPER does. Every assertion above about the contents drawer runs against a
  // fixture that HAS one, so none of them could see that the drawer is empty on
  // most of what people actually read on this surface.
  //
  // This imports a paper with no /Outlines at all and headings set only in
  // larger type — a preprint, in other words — and asks whether the drawer
  // fills in anyway.
  if (!OWN_PDF) {
    const noOutline = buildFixturePdf({ pages: 6, annotate: false, outline: false, headingSize: 18 });
    const derived = await page.evaluate(`async (bytes) => {
      const { api, settle } = window.__recall;
      const before = api.readLocalDeckIndex().map((m) => m.id);
      const file = new File([new Uint8Array(bytes)], "no-outline.pdf", { type: "application/pdf" });
      await api.importPdfFile(file, null);
      await settle(400);
      const entry = api.readLocalDeckIndex().find((m) => !before.includes(m.id));
      if (!entry) return { error: "no deck was created for the outline-less PDF" };
      await api.loadDeckFromLibrary(entry.id);
      await settle(300);
      api.closeMyDecksPanel();
      api.setViewMode("document");
      await api.openDocumentView({ force: true });
      await api.whenDocumentPageReady(1);
      // The scan runs in the BACKGROUND, off the open path — that is the whole
      // design — so it is waited for rather than assumed.
      for (let i = 0; i < 120 && !api.documentOutlineEntries().length; i += 1) await settle(100);
      await settle(400);
      const entries = api.documentOutlineEntries().map((e) => ({ title: e.title, page: e.page, depth: e.depth }));
      document.getElementById("documentTocBtn").click();
      await settle(400);
      const drawer = document.getElementById("documentOutlineDrawer");
      const rows = Array.from(drawer.querySelectorAll(".notes-toc-link")).map((row) => ({
        text: row.querySelector(".notes-toc-text").textContent,
        page: row.querySelector(".document-toc-page")?.textContent || "",
        hidden: Boolean(row.closest(".notes-toc-item").hidden)
      }));
      const result = {
        entries,
        rows,
        derivedNote: drawer.querySelector(".document-toc-derived")?.textContent || "",
        branches: drawer.querySelectorAll(".notes-toc-item.is-branch").length,
        twisties: drawer.querySelectorAll(".notes-toc-twisty").length,
        rails: drawer.querySelectorAll(".notes-toc-rail").length,
        foldAllHidden: document.getElementById("documentTocFoldAllBtn").hidden,
        cached: JSON.parse(JSON.stringify(api.state.meta?.pdfToc || null)),
        deckId: entry.id
      };
      document.getElementById("documentTocCloseBtn").click();
      await settle(300);
      // ...and back off disk, which is the half that says the cache is real: a
      // second session must not pay for the scan again.
      for (let i = 0; i < 60 && api.deckAutosaveTimer; i += 1) await settle(100);
      await api.loadDeckFromLibrary(entry.id);
      await settle(300);
      api.closeMyDecksPanel();
      api.setViewMode("document");
      await api.openDocumentView({ force: true });
      await api.whenDocumentPageReady(1);
      const started = performance.now();
      for (let i = 0; i < 60 && !api.documentOutlineEntries().length; i += 1) await settle(50);
      result.reloadMs = Math.round(performance.now() - started);
      result.afterReload = api.documentOutlineEntries().map((e) => ({ title: e.title, page: e.page, depth: e.depth }));
      result.stillDerived = api.isDocumentOutlineDerived();
      return result;
    }`, Array.from(noOutline.bytes));

    if (derived.error) throw new Error(derived.error);
    const tops = derived.entries.filter((e) => e.depth === 0);
    const subs = derived.entries.filter((e) => e.depth === 1);
    check("a PDF with no outline still gets a contents, read off its pages",
      derived.entries.length > 0, `${derived.entries.length} entr(y/ies)`);
    check("...one heading per page, on the right page",
      tops.length === noOutline.pages
        && tops.every((e, i) => e.title === noOutline.headings[i].title && e.page === i + 1),
      tops.map((e) => `${e.title}→${e.page}`).join(" · ").slice(0, 90));
    check("...with a numbered subsection one level under it",
      subs.length === noOutline.pages
        && subs.every((e, i) => e.title === noOutline.headings[i].sub && e.page === i + 1),
      subs.map((e) => `${e.title}→${e.page}`).join(" · ").slice(0, 90));
    check("...and nothing else off the page mistaken for a heading",
      derived.entries.length === tops.length + subs.length,
      `${derived.entries.length} kept of ${tops.length + subs.length} wanted`);
    check("...drawn as the SAME tree the notes contents draws",
      derived.rows.length === derived.entries.length && derived.branches === noOutline.pages
        && derived.twisties === noOutline.pages && derived.rails > 0 && !derived.foldAllHidden,
      `${derived.rows.length} row(s), ${derived.branches} branch(es), ${derived.rails} rail(s)`);
    check("...folded to its top level on open, exactly as a note's contents is",
      derived.rows.filter((r) => r.hidden).length === subs.length,
      `${derived.rows.filter((r) => r.hidden).length} of ${derived.rows.length} row(s) folded away`);
    check("...saying it was inferred rather than read from the file",
      /found in the text/i.test(derived.derivedNote), derived.derivedNote.slice(0, 70));
    check("...and each row carrying the page it goes to",
      derived.rows.every((r) => /^\d+$/.test(r.page)),
      derived.rows.map((r) => r.page).join(","));
    check("the derived contents is cached on the deck",
      derived.cached?.pages === noOutline.pages && derived.cached.entries.length === derived.entries.length,
      `v${derived.cached?.v} · ${derived.cached?.entries?.length} entr(y/ies) for ${derived.cached?.pages} page(s)`);
    check("...so re-opening the deck does not scan the pages again",
      derived.afterReload.length === derived.entries.length
        && derived.afterReload.every((e, i) => e.title === derived.entries[i].title && e.page === derived.entries[i].page)
        && derived.stillDerived,
      `${derived.afterReload.length} entr(y/ies) back in ${derived.reloadMs}ms`);
  }

  // ── How a heavily annotated paper scales ─────────────────────────────────
  //
  // Every surface that lists a paper's highlights has to resolve each one's note
  // out of the fenced block at the end of state.notes, and reading that block
  // means walking all of it. Ask per record and the cost is quadratic in how
  // many highlights the paper has — and paintPageNoteBadges asks from the
  // page-painted hook, so the reader pays it again for every page they scroll
  // past. Measured before this was fixed: 3.9ms to paint four pages' badges at
  // 25 annotated highlights and 312ms at 300, which is what "rendering and
  // scrolling became hella slow" was made of.
  //
  // ── Why a ratio, and why the bound is where it is ──────────────────────
  //
  // A millisecond budget would mean different things on a fast laptop and a
  // loaded CI box, so this asks how the cost GROWS: twelve times the highlights
  // must not cost anything like twelve times squared. Linear is ~12x plus
  // whatever constant per-page DOM work there is; quadratic is ~144x, and the
  // version this replaced measured 80x. 45 sits clear of both — high enough that
  // a slow machine cannot trip it, low enough that the regression cannot hide
  // under it. A guard that fails on noise trains the eye to ignore a red line.
  //
  // Both ends are measured over enough repetitions to be well above timer
  // resolution, and the pages are confirmed rendered first: paintPageNoteBadges
  // returns immediately for a page that has no text layer yet, so measuring
  // before they are up times an early return and proves nothing.
  const scaling = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const before = { notes: api.state.notes, meta: api.state.meta };
    for (let p = 1; p <= 4; p += 1) {
      api.scrollToDocumentPage(p, 0, { smooth: false });
      await api.whenDocumentPageReady(p);
    }
    api.scrollToDocumentPage(1, 0, { smooth: false });
    await settle(200);
    const live = [1, 2, 3, 4].filter((p) => document.querySelector('.pdf-page[data-page-number="' + p + '"] .pdf-text-layer'));

    const build = (k) => {
      const records = [];
      let notes = "";
      for (let i = 0; i < k; i += 1) {
        const id = "hn-" + (100000 + i).toString(36);
        const page = (i % 4) + 1;
        records.push({ id, color: "yellow", page, kind: "text",
          text: "some highlighted words number " + i,
          quads: [{ page, rect: [72, 700 - (i % 30) * 18, 300, 712 - (i % 30) * 18] }],
          anchor: { page, item: 0, ch: 0 }, focus: { page, item: 0, ch: 0 },
          qv: 1, at: 1, noteAt: 1 });
        notes = api.setHighlightNoteInSource(notes, id, "A note of a few words about highlight " + i + ".", "“words " + i + "”");
      }
      return { records, notes };
    };
    const REPS = 30;
    const measure = async (k) => {
      const { records, notes } = build(k);
      api.state.meta = { ...api.state.meta, pdfHighlights: records };
      api.state.notes = notes;
      await settle(50);
      // Warm, then measure: the first pass pays for a badge layer every later
      // pass reuses, and that one-off would land entirely on whichever end of
      // the comparison ran first.
      for (const p of live) api.paintPageNoteBadges(p);
      const started = performance.now();
      for (let r = 0; r < REPS; r += 1) for (const p of live) api.paintPageNoteBadges(p);
      return (performance.now() - started) / REPS;
    };
    const small = await measure(25);
    const large = await measure(300);
    api.state.notes = before.notes;
    api.state.meta = before.meta;
    api.repaintPdfPageNotes();
    await settle(100);
    return {
      pages: live.length,
      small: +small.toFixed(2),
      large: +large.toFixed(2),
      ratio: +(large / Math.max(small, 0.001)).toFixed(1)
    };
  }`);

  check("the scaling measurement actually has pages to paint on",
    scaling.pages > 0 && scaling.small > 0,
    `${scaling.pages} rendered page(s), ${scaling.small}ms per pass at 25 highlights`);
  check("painting a page's note badges scales with the highlights, not their square",
    scaling.ratio < 45,
    `12x the highlights cost ${scaling.ratio}x the time (${scaling.small}ms → ${scaling.large}ms per pass over ${scaling.pages} page(s))`);

  // ── Attaching a paper to a deck that already exists ──────────────────────
  //
  // "Once a deck has been created without a PDF there is no option to attach one
  // again." Every route into the Document surface used to start with an IMPORT,
  // which makes a new deck, and "Re-attach the PDF…" lives inside a surface that
  // does not exist until meta.pdf does — so a deck whose import failed, or one
  // whose notes were written before the file was to hand, had no way in at all.
  const attached = await page.evaluate(`async (bytes, name) => {
    const { api, settle } = window.__recall;
    api.closeMyDecksPanel();
    // A perfectly ordinary deck: notes, no document, nothing PDF-shaped anywhere
    // near it.
    api.state.deckId = null;
    api.state.localDeckId = null;
    api.state.deckTitle = "A deck that had no paper";
    api.state.deckCategory = "";
    api.state.notes = "# Written before the paper turned up\\n\\nSome notes.";
    api.state.masterCards = [];
    api.state.cards = [];
    api.state.meta = {};
    api.setViewMode("notes");
    await api.saveDeckToLibrary({ silent: true });
    // Through the ordinary open path, so the chrome is painted from this deck
    // rather than from whatever the previous case left on screen —
    // refreshDocumentTab is what hides the Document tab and shows the attach
    // row, and it runs from updateMeta, which loading is what triggers.
    await api.loadDeckFromLibrary(api.state.localDeckId);
    await settle(300);
    const rowBefore = document.getElementById("attachPdfBtn")?.hidden;
    const tabBefore = document.querySelector('#viewModeToggle [data-view-mode="document"]')?.hidden;

    // ── ...and the panel that offers it ───────────────────────────────────
    //
    // "The attach pdf needs to be inside the panels itself." The drawer row
    // above is a route you have to be told about; the Document tab is on every
    // deck now, and on one with no paper it opens to the offer of a paper. So:
    // press the tab the way a reader does, and read what is in the panel.
    document.querySelector('#viewModeToggle [data-view-mode="document"]')?.click();
    await settle(350);
    const panelView = api.state.viewMode;
    const panel = document.querySelector("#documentView .pdf-missing");
    const panelHeading = panel?.querySelector("h2")?.textContent || "";
    const panelPicks = Boolean(panel?.querySelector('.pdf-missing-pick input[type="file"]'));
    // The document's own controls have nothing to act on here, and four inert
    // buttons over an attach panel is the same fault as a table of contents over
    // a paper — see styles/37-document-chrome.css.
    const inertShown = ["documentTocBtn", "documentDarkBtn", "documentRegionBtn", "documentMoreBtn"]
      .filter((id) => {
        const node = document.getElementById(id);
        return node && getComputedStyle(node).display !== "none";
      });
    const pagerShown = getComputedStyle(document.getElementById("documentPager")).display !== "none";

    const file = new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
    const ok = await api.attachPdfToOpenDeck(file);
    await settle(700);
    // Refused a second time, so the two controls are never both on offer.
    const twice = await api.attachPdfToOpenDeck(file);
    await settle(200);

    return {
      ok, twice,
      rowBefore, tabBefore,
      panelView, panelHeading, panelPicks, inertShown, pagerShown,
      rowAfter: document.getElementById("attachPdfBtn")?.hidden,
      tabAfter: document.querySelector('#viewModeToggle [data-view-mode="document"]')?.hidden,
      title: api.state.deckTitle,
      notesKept: (api.state.notes || "").indexOf("Written before the paper turned up") !== -1,
      pages: api.state.meta?.pdf?.pages || 0,
      sha: (api.state.meta?.pdf?.sha256 || "").length,
      highlights: (api.state.meta?.pdfHighlights || []).length,
      viewMode: api.state.viewMode,
      stored: Boolean(await api.readDocument(api.state.localDeckId).then((e) => e?.blob).catch(() => null)),
      painted: document.querySelectorAll(".pdf-page").length
    };
  }`, Array.from(fixture.bytes), "attached.pdf");

  check("a deck created without a PDF offers a way to attach one", attached.rowBefore === false,
    `row hidden=${attached.rowBefore}, Document tab hidden=${attached.tabBefore}`);
  check("...including a Document tab, on a deck that has no document",
    attached.tabBefore === false, `tab hidden=${attached.tabBefore}`);
  check("...which opens to the offer of one, inside the panel",
    attached.panelView === "document" && attached.panelPicks && /attach/i.test(attached.panelHeading),
    `view=${attached.panelView} · “${attached.panelHeading}” · picker=${attached.panelPicks}`);
  check("...with no document controls hanging over it",
    attached.inertShown.length === 0 && attached.pagerShown === false,
    attached.inertShown.length ? `still shown: ${attached.inertShown.join(", ")}` : `pager=${attached.pagerShown}`);
  check("...and attaching one gives that deck a Document tab", attached.ok && attached.tabAfter === false,
    `attached=${attached.ok}, tab hidden=${attached.tabAfter}, view=${attached.viewMode}`);
  check("...with the file's pages and hash on the deck", attached.pages > 0 && attached.sha === 64,
    `${attached.pages} page(s), sha256 ${attached.sha} chars`);
  check("...and the bytes on this device, so it reads offline", attached.stored && attached.painted > 0,
    `stored=${attached.stored}, ${attached.painted} page(s) painted`);
  check("...leaving the deck's own title and notes exactly as they were",
    attached.title === "A deck that had no paper" && attached.notesKept,
    `title "${attached.title}", notes ${attached.notesKept ? "kept" : "LOST"}`);
  check("...and highlights already in the file imported with it", attached.highlights >= (fixture.annotation ? 1 : 0),
    `${attached.highlights} record(s)`);
  check("the row goes away once the deck has a document", attached.rowAfter === true && attached.twice === false,
    `row hidden=${attached.rowAfter}, second attach refused=${attached.twice === false}`);

  // ── A phone on its side ──────────────────────────────────────────────────
  //
  // "In mobile view the hamburger in full screen / focus mode is not there, and
  // it's not seamlessly changing the modes. There should be some dedicated
  // reliable button for full / focus screen in even mobile screen landscape
  // mode."
  //
  // Every rail assertion above ran at a desktop-shaped viewport, and the two
  // faults were both about the OTHER shape:
  //
  //   * CHROME_MOBILE_QUERY was `(max-width: 720px)` alone. A phone in landscape
  //     is ~844x390 — wider than that — so isMobileChrome() answered false on
  //     the exact device the whole scroll-driven collapse was written for. The
  //     scroll listener in src/main.js bails on it, so a landscape phone could
  //     not enter focus mode by reading at all;
  //   * applyChromeCollapse ANDed the scroll LOCK with the same query, so
  //     rotating a phone that was already in focus mode dropped the mode
  //     mid-sentence — the header came back, and the rail (display:none unless
  //     the chrome was folded) went with it. That is the missing hamburger.
  //
  // The rotation is a real one: the metrics change, and whether a `change` event
  // fires on chromeMobileMedia is up to the browser evaluating the query. The
  // point of the widened query is that it does NOT fire, because both shapes of
  // the same phone match it.
  await emulatePhone(page, { width: 390, height: 844 });
  const landscape = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setFocusMode(false);
    await settle(200);
    const portraitIsMobile = api.isMobileChrome();
    // Into focus mode by READING, not by pressing the button — the pin has always
    // survived a rotation and the lock is the half that did not. trackChromeScroll
    // is what the document-level scroll listener calls once per frame; two calls
    // are an anchor and a downward scroll past CHROME_HIDE_DELTA.
    const scroller = document.getElementById("documentView");
    scroller.scrollTop = 0;
    api.trackChromeScroll(scroller);
    scroller.scrollTop = 400;
    api.trackChromeScroll(scroller);
    await settle(400);
    const lockedInPortrait = document.body.classList.contains("chrome-collapsed");
    return { portraitIsMobile, lockedInPortrait };
  }`);

  await emulatePhone(page, { width: 844, height: 390 });
  const rotated = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    // Long enough for a matchMedia change listener to have fired if the query
    // flipped, and for the 220ms fold transition either way.
    await settle(500);
    const stillLocked = document.body.classList.contains("chrome-collapsed");
    const landscapeIsMobile = api.isMobileChrome();
    const railBox = document.getElementById("readingRail").getBoundingClientRect();
    const grip = document.getElementById("readingRailGrip");
    const gripRect = grip.getBoundingClientRect();
    const gripOnScreen = getComputedStyle(document.getElementById("readingRail")).display !== "none"
      && gripRect.width >= 24 && gripRect.height >= 24
      && gripRect.top >= 0 && gripRect.bottom <= window.innerHeight
      && gripRect.right <= window.innerWidth + 1;
    const hit = document.elementFromPoint(gripRect.left + gripRect.width / 2, gripRect.top + gripRect.height / 2);
    const gripIsHit = Boolean(hit) && (hit === grip || grip.contains(hit));
    grip.click();
    await settle(200);
    const tray = document.getElementById("readingRailTray");
    const trayRect = tray.getBoundingClientRect();
    // The tray has to fit the screen it is on, not overhang it — the box is
    // pinned top and bottom now precisely so its max-height of 100% is the real
    // remaining height rather than a fraction of the viewport.
    const trayFits = trayRect.top >= 0 && trayRect.bottom <= window.innerHeight + 1;
    // ...and the two mode rows have to be reachable WITHOUT scrolling the tray,
    // which is the whole of "a dedicated reliable button for full / focus
    // screen". Measured from the unscrolled tray, as a reader finds it.
    const modes = tray.querySelector(".rr-modes").getBoundingClientRect();
    const modesReachable = modes.height > 0
      && modes.bottom <= trayRect.bottom + 1 && modes.top >= trayRect.top - 1;
    const focusRow = tray.querySelector('[data-rail-action="focus"]');
    const immersiveRow = tray.querySelector('[data-rail-action="immersive"]');
    const focusSaysOn = focusRow.getAttribute("aria-pressed") === "true";
    // Pressing it leaves focus mode AND leaves the tray open, so the switch can
    // be seen to move and pressed again. It used to close the tray on every row.
    focusRow.click();
    await settle(450);
    const leftFocus = !document.body.classList.contains("chrome-collapsed");
    const trayStayedOpen = document.getElementById("readingRail").dataset.expanded === "true";
    const focusSaysOff = focusRow.getAttribute("aria-pressed") === "false";
    // ...and back in from the same row, at the same landscape size, with the
    // chrome up: the rail is the way IN now, not only the way out.
    focusRow.click();
    await settle(450);
    const backIn = document.body.classList.contains("chrome-collapsed");
    document.getElementById("readingRail").dataset.expanded = "false";
    api.setFocusMode(false);
    await settle(300);
    return { stillLocked, landscapeIsMobile, gripOnScreen, gripIsHit, trayFits, modesReachable, focusSaysOn, leftFocus, trayStayedOpen, focusSaysOff, backIn, railW: Math.round(railBox.width) };
  }`);

  check("a phone counts as a phone in portrait", landscape.portraitIsMobile, `isMobileChrome=${landscape.portraitIsMobile}`);
  check("...and scrolling down a paper locks the chrome away", landscape.lockedInPortrait,
    `chrome-collapsed=${landscape.lockedInPortrait}`);
  check("...and it is still a phone once it is turned on its side",
    rotated.landscapeIsMobile, `isMobileChrome=${rotated.landscapeIsMobile} at 844x390`);
  check("...so rotating does not throw focus mode away", rotated.stillLocked,
    `chrome-collapsed after rotate=${rotated.stillLocked}`);
  check("...and the hamburger is on the landscape screen, hittable",
    rotated.gripOnScreen && rotated.gripIsHit,
    `onScreen=${rotated.gripOnScreen} hit=${rotated.gripIsHit}`);
  check("...with a tray that fits the short screen",
    rotated.trayFits, `fits=${rotated.trayFits}`);
  check("...and focus / full screen reachable in it without scrolling",
    rotated.modesReachable, `reachable=${rotated.modesReachable}`);
  check("...saying focus mode is on, and turning it off when pressed",
    rotated.focusSaysOn && rotated.leftFocus && rotated.focusSaysOff,
    `on=${rotated.focusSaysOn} left=${rotated.leftFocus} nowOff=${rotated.focusSaysOff}`);
  check("...leaving the tray open, so the switch can be pressed again",
    rotated.trayStayedOpen, `trayOpen=${rotated.trayStayedOpen}`);
  check("...and the same row takes a landscape phone back INTO focus mode",
    rotated.backIn, `chrome-collapsed=${rotated.backIn}`);

  if (SHOT) {
    if (SHOT_PAGES) await emulatePhone(page, { width: 390, height: 780 });
    // The Document surface itself, not whatever the last assertion happened to
    // leave on screen — the run ends inside the un-annotated-import case, which
    // finishes with My Decks open over the whole window.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.closeMyDecksPanel();
      await settle(100);
      // The deck with HIGHLIGHTS on it, not simply the first one in the index:
      // the run also imports a slide deck and an un-annotated paper, and a shot
      // of a document with nothing marked on it shows none of what this feature
      // is. Falls back to the first deck if somehow none has any.
      const index = api.readLocalDeckIndex();
      let picked = null;
      for (const entry of index) {
        await api.loadDeckFromLibrary(entry.id);
        await settle(200);
        if ((api.state.meta && api.state.meta.pdfHighlights || []).length) { picked = entry.id; break; }
      }
      if (!picked) await api.loadDeckFromLibrary(index[0].id);
      await settle(300);
      api.closeMyDecksPanel();
      api.setViewMode("document");
      await api.openDocumentView({ force: true });
      await api.whenDocumentPageReady(1);
      await settle(400);
      // The import's own toast sits over the control row this shot exists to
      // show — it is the check's doing, not the app's.
      document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove());
      // ...and, with --shot-menu, the export menu open over it: it is new UI
      // built per view, and a shot of the row alone cannot show whether its rows
      // are the RIGHT ones for the view under them.
      if (SHOT_MENU) {
        api.paintViewExportMenu();
        document.getElementById("viewExportBtn").click();
        await settle(120);
      }
      if (SHOT_PAGES) {
        api.setPdfPageNotesFlag(false);
        api.togglePdfPageNotes();
        await api.whenDocumentPageReady(2);
        await settle(300);
        api.scrollToDocumentPage(2, 0, { smooth: false });
        await settle(500);
      }
      if (SHOT_NOTES) {
        api.openHighlightSplit("document");
        await settle(600);
      }
      if (SHOT_TOC) {
        // Only if it is not already open. The stages above open this drawer
        // several times over now, and a bare click on a toggle that is already
        // on is a click that turns it off — which is a screenshot of no drawer.
        if (!document.getElementById("documentOutlineDrawer").classList.contains("is-open")) {
          document.getElementById("documentTocBtn").click();
        }
        await settle(400);
        api.setDrawerSection(document.getElementById("documentOutlineDrawer"), "SHOT_TOC_SECTION");
        await settle(300);
      }
      await settle(60);
    }`.replace("SHOT_MENU", String(SHOT_MENU))
      .replace("SHOT_PAGES", String(SHOT_PAGES))
      .replace("SHOT_TOC_SECTION", SHOT_TOC_SECTION)
      .replace("SHOT_TOC", String(SHOT_TOC))
      .replace("SHOT_NOTES", String(SHOT_NOTES)));
    const shot = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.resolve(ROOT, SHOT), Buffer.from(shot.data, "base64"));
    console.log(`      screenshot → ${SHOT}`);
  }
} catch (error) {
  console.log(`  FAIL  the check itself: ${error?.message || error}`);
  failures.push("harness");
} finally {
  clearTimeout(watchdog);
  client.close();
  // SIGKILL, not the default SIGTERM: check.mjs reads this process's output
  // through a pipe every descendant inherits, so a Chrome that lingers keeps
  // that pipe open and the suite waits on a check that has already finished.
  launched.proc.kill("SIGKILL");
  server.proc.kill("SIGKILL");
}

notes.forEach((note) => console.log(`  note  ${note}`));
if (failures.length) {
  console.log(`\npdf-preview-check: ${failures.length} failure(s) — ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\npdf-preview-check: ${fixture.pages || "?"} pages · text layers, anchors, quads and a reload round-trip all hold`);
