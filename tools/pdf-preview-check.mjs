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
    "/src/panels/highlights-panel.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
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
    check(
      "its comment lands in the note's Highlight Notes section",
      imported.notes.includes("## Highlight Notes") && imported.notes.includes(fixture.annotation.comment),
      imported.notes.includes(fixture.annotation.comment) ? "" : JSON.stringify(imported.notes.slice(0, 120))
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

  // ── 6. A PDF with no annotations in it ───────────────────────────────────
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
