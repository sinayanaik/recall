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
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { buildFixturePdf, fixtureLineOrigin } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SHOT = (args.find((a) => a.startsWith("--shot=")) || "").slice(7)
  || (args.includes("--shot") ? "pdf-document.png" : "");
const OWN_PDF = args.find((a) => a.endsWith(".pdf"));

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
    "/src/panels/highlights-panel.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/documents/pdf-region.js?v=__BUILD__",
    "/src/documents/pdf-page-notes.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/reading-rail.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
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
  }

  // ── 5. Reload from IndexedDB, and repaint ────────────────────────────────
  const reloaded = await page.evaluate(`async (pageNumber, id) => {
    const { api, settle } = window.__recall;
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
      record: record ? { quads: record.quads, color: record.color, anchor: record.anchor } : null,
      painted,
      rows: api.collectDeckHighlights().length
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
      const tab = document.querySelector('[data-view-mode="highlights"]');
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
    check(`the four tabs sit on one line (${label})`, oneLine && row.tabTops.length === 4,
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
  }

  // ── 8b. The container the notes live in ──────────────────────────────────
  //
  // Three things this format has to get right, and every one of them is a
  // report from use rather than a hypothetical:
  //
  //   the raw editor must not open full of highlight notes. On a PDF deck the
  //   body is empty — the PDF IS the document — so the "## Highlight Notes"
  //   section used to be the entire contents of the textarea, with nothing
  //   separating it from the writing the reader came to do;
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
      innocentUntouched: api.fenceLegacySection(innocent) === innocent
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
  // Decks with them. The rail is what stays behind — so the assertions are the
  // two halves of that bargain: it is NOT on screen when the chrome is expanded
  // (a second copy of a visible control), and it IS when the chrome is folded.
  //
  // Read through getComputedStyle rather than the hidden attribute, because both
  // facts are decided by a :has() rule from <body> and an element that is merely
  // present in the markup would pass a naive check.
  const rail = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const shown = () => {
      const node = document.getElementById("readingRail");
      return Boolean(node) && getComputedStyle(node).display !== "none";
    };
    api.setFocusMode(false);
    await settle(150);
    const beforeFocus = shown();
    api.setFocusMode(true);
    // The fold is a 220ms CSS transition (styles/16-mobile-reading.css:331), so
    // the row's height is only honest once it has finished — 150ms here caught
    // it mid-collapse and read as a rail that had not appeared.
    await settle(450);
    const inFocus = shown();
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
    const buttons = Array.from(tray.querySelectorAll("button")).filter((b) => !b.hidden).length;
    const labelled = Array.from(tray.querySelectorAll("button")).filter((b) => !b.hidden)
      .every((b) => (b.querySelector(".rr-label")?.textContent || "").trim().length > 0);
    const documentIconShown = !tray.querySelector('[data-view-mode="document"]').hidden;
    const activeMatches = tray.querySelector('[data-view-mode="document"]').classList.contains("is-active");
    // The tray's own view buttons have to actually switch view.
    tray.querySelector('[data-view-mode="highlights"]').click();
    await settle(250);
    const switched = api.state.viewMode;
    const collapsedAfterUse = getComputedStyle(tray).display === "none";
    // ...and leaving focus mode has to take the rail with it.
    api.setFocusMode(false);
    await settle(450);
    const afterFocus = shown();
    api.setViewMode("document");
    await settle(200);
    return { beforeFocus, inFocus, rowFolded, expanded, buttons, labelled, gripBox, gripIsHit, documentIconShown, activeMatches, switched, collapsedAfterUse, afterFocus };
  }`);

  check("the rail stays off screen while the chrome is expanded",
    rail.beforeFocus === false && rail.afterFocus === false,
    `before=${rail.beforeFocus} after=${rail.afterFocus}`);
  check("...and appears when focus mode folds the row away",
    rail.inFocus === true && rail.rowFolded,
    `rail=${rail.inFocus} rowFolded=${rail.rowFolded}`);
  check("...as a hamburger big enough to find, and hittable",
    rail.gripBox.w >= 24 && rail.gripBox.h >= 24 && rail.gripIsHit,
    `${rail.gripBox.w}×${rail.gripBox.h}px · hit=${rail.gripIsHit}`);
  check("the grip expands it into the controls focus mode took",
    rail.expanded && rail.buttons === 7,
    `${rail.buttons} button(s)`);
  check("...every one of them named, not just drawn",
    rail.labelled, `labels=${rail.labelled}`);
  check("...including the Document view, lit for the view you are in",
    rail.documentIconShown && rail.activeMatches,
    `shown=${rail.documentIconShown} active=${rail.activeMatches}`);
  check("...and its view buttons switch view, then put the tray away",
    rail.switched === "highlights" && rail.collapsedAfterUse,
    `viewMode=${rail.switched} collapsed=${rail.collapsedAfterUse}`);

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

  if (SHOT) {
    // The Document surface itself, not whatever the last assertion happened to
    // leave on screen — the run ends inside the un-annotated-import case, which
    // finishes with My Decks open over the whole window.
    await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.closeMyDecksPanel();
      await settle(100);
      await api.loadDeckFromLibrary(api.readLocalDeckIndex()[0].id);
      await settle(300);
      api.closeMyDecksPanel();
      api.setViewMode("document");
      await api.openDocumentView({ force: true });
      await api.whenDocumentPageReady(1);
      await settle(400);
      // The import's own toast sits over the control row this shot exists to
      // show — it is the check's doing, not the app's.
      document.querySelectorAll(".toast, #toastHost > *").forEach((n) => n.remove());
      await settle(60);
    }`);
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
