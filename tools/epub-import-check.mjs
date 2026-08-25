// Does importing an EPUB actually work — preview, figures, chapters and decks?
//
//   node tools/epub-import-check.mjs
//   node tools/epub-import-check.mjs some-real-book.epub   # ...against your own
//
// tools/epub-preview-check.mjs already renders a book's chapters through the
// real converter and dumps them for a human to read. This asks the other half
// of the question, the half nothing asked: does the IMPORT — the modal, the
// figure uploads, the decks — still run at all?
//
// It exists because it did not. The figure-quality control added to the preview
// modal read an `imageEntries` the modal was never given, so the executor threw
// a ReferenceError BEFORE the modal reached the DOM and every book with so much
// as one picture in it — which is every book — failed at "Could not import this
// EPUB". Nothing in tools/ noticed: module-symbols only asks whether a name
// another MODULE owns is imported, and `imageEntries` is a parameter name three
// other functions in that same file legitimately use; the preview check never
// opens the modal; and every other browser check drives notes, cards or papers.
// A whole headline feature was dead in a repo with thirty checks.
//
// So this one drives the feature end to end, in a real browser, through the
// app's own importEpubFile — and asserts the things that can be wrong without
// anything crashing:
//
//   1. the modal OPENS, which is the regression above, and says what the book
//      is: title, author, the chapter count the PLAN produced (five, from four
//      spine files) and the figures in the manifest;
//   2. the figure-quality estimate settles on a real number rather than sitting
//      at "Estimating…" — it samples and re-encodes actual images, so it is the
//      one part of the modal that can hang;
//   3. the chapter list is the book's own table of contents, including the
//      front-matter page the contents does not name and the chapter cut out of
//      the middle of a shared file;
//   4. expanding a chapter renders its note WITH its pictures, decoded from the
//      zip — including the figure whose archive entry is spelled differently
//      from the href that points at it, which is the case that silently drops
//      a book's illustrations;
//   5. Import writes one deck per chapter, in reading order, in a folder named
//      after the book, each with its own text, the anchored chapter's duplicated
//      heading dropped, and every figure rewritten to its hosted URL;
//   6. the reader's OWN open deck comes back exactly as it was — including its
//      meta, which the chapter loop stamps over and which was not among the
//      state the import put back;
//   7. ...and the whole-book mode saves one deck with every chapter title kept
//      as a heading.
//
// Speaks CDP directly (tools/cdp.mjs) rather than through puppeteer, for the
// reason every check here that does: a check that skips is a check that never
// catches anything.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";
import { buildFixtureEpub, FIXTURE_CHAPTER_MARKERS } from "./epub-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OWN_EPUB = args.find((a) => a.endsWith(".epub"));
// Prints every imported deck's markdown and the storage paths the figures went
// to. The assertions below answer "is this right"; this answers "then what IS
// it", which is the question every failure here immediately raises — and the
// only way to ask it of a book of your own without editing this file.
const DUMP = args.includes("--dump");

// ── The libraries the import needs, locally ─────────────────────────────────
//
// An EPUB import touches two deferred CDN libraries: JSZip to open the book,
// and Turndown (plus its GFM plugin) to turn each chapter's HTML into markdown.
// The app loads all three from jsdelivr on demand and the service worker
// precaches them, which is right for a browser and useless to a check that may
// have no route to a CDN. Each is fetched once from npm, cached under /tmp and
// INJECTED before the app's own scripts — which also means this exercises the
// "already on window" branch of ensureJsZip/ensureTurndown rather than
// depending on a network fetch mid-run.
//
// Every version here must match its LIB_URLS entry in src/core/lib-loader.js. A
// check that passes against a different Turndown than the app ships proves
// nothing about the app — and the ORDER matters as much as the versions: the
// GFM plugin augments TurndownService and has to come second, exactly as
// ensureTurndown loads them.
const CACHE_DIR = "/tmp/recall-epub-libs";

const CDN_LIBS = [
  { name: "jszip", version: "3.10.1", file: "package/dist/jszip.min.js" },
  { name: "turndown", version: "7.1.2", file: "package/dist/turndown.js" },
  { name: "turndown-plugin-gfm", version: "1.0.2", file: "package/dist/turndown-plugin-gfm.js" }
];

function cdnLibSource({ name, version, file }) {
  const dir = path.join(CACHE_DIR, `${name}-${version}`);
  const dist = path.join(dir, file);
  if (!existsSync(dist)) {
    mkdirSync(dir, { recursive: true });
    const tarball = `${name}-${version}.tgz`;
    if (!existsSync(path.join(dir, tarball))) {
      execFileSync("npm", ["pack", `${name}@${version}`], { cwd: dir, stdio: "ignore" });
    }
    execFileSync("tar", ["xzf", tarball, file], { cwd: dir, stdio: "ignore" });
  }
  return readFileSync(dist, "utf8");
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

// The app exposes no global API, so the modules this drives are imported and
// flattened into one object — the same approach as pdf-preview-check's.
const API_SRC = `async () => {
  const paths = [
    "/src/import/epub.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/library/my-decks-menu.js?v=__BUILD__",
    "/src/library/my-decks-prefs.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// Signed in, with a storage stub that ACCEPTS uploads: the point here is the
// path where every figure lands, so the notes can be asserted to carry hosted
// URLs. Each upload's own path comes back in the URL, which is what makes
// "which figure is this" answerable from the markdown alone.
const SETUP_SRC = `async (apiSrc) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const uploaded = [];
  // What the bucket KEPT, as opposed to what it was handed. The two are the
  // same until __swallowUpload is set, which is how "the upload came back clean
  // and stored nothing" — the failure the whole read-back exists for — gets
  // asked for on purpose.
  const stored = [];
  window.__recall = { api, settle, uploaded, stored };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("epub-import-check does not touch the deck tables"); },
    storage: { from: () => ({
      upload: async (p) => {
        uploaded.push(p);
        if (!window.__swallowUpload || !p.includes(window.__swallowUpload)) stored.push(p);
        return { data: { path: p }, error: null };
      },
      remove: async () => ({ error: null }),
      // A bucket that actually holds what it was handed. The import reads the
      // run's folder back before it writes the figures' URLs into the notes
      // (dropUnstoredEpubImages), and a stub that accepts every upload and then
      // lists nothing is not standing in for a backend — it is standing in for
      // a broken one, and it would make the read-back the thing under test
      // rather than the import. \`window.__swallowUpload\` is how the broken
      // case gets asked for deliberately.
      list: async (dir) => ({
        data: stored
          .filter((p) => p.slice(0, p.lastIndexOf("/")) === dir)
          .map((p, i) => ({ id: "obj-" + i, name: p.slice(p.lastIndexOf("/") + 1), metadata: { size: 1 } })),
        error: null
      }),
      createSignedUrls: async () => ({ data: [], error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: "https://example.supabase.co/storage/v1/object/public/images/" + p } })
    }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  return true;
}`;

// tools/check.mjs reads each check through spawnSync when it exits, so a check
// that hangs does not fail the suite — it stops it, with nothing on screen to
// say which one. Hence an explicit deadline that turns a hang into an ordinary
// named failure.
export const WATCHDOG_MS = 5 * 60 * 1000;

const chrome = findChrome();
if (!chrome) { console.log("epub-import-check: no Chrome on this machine — skipping."); process.exit(0); }

let libSources;
try {
  libSources = CDN_LIBS.map(cdnLibSource);
} catch (error) {
  console.log(`epub-import-check: could not obtain the import's libraries (${error?.message || error}) — skipping.`);
  process.exit(0);
}

const fixture = OWN_EPUB
  ? { bytes: new Uint8Array(readFileSync(OWN_EPUB)), title: null, author: null, chapters: null, numbered: null, images: null, spineFiles: null }
  : buildFixtureEpub();
const fileName = OWN_EPUB ? path.basename(OWN_EPUB) : "quiet-machines.epub";

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

const watchdog = setTimeout(() => {
  console.log(`  FAIL  the check itself: gave up after ${WATCHDOG_MS / 1000}s`);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  try { server.proc.kill("SIGKILL"); } catch (_) { /* already gone */ }
  process.exit(1);
}, WATCHDOG_MS);

const failures = [];
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
  // Before the app's own scripts, so ensureJsZip and ensureTurndown each find
  // their library already on window.
  await page.call("Page.addScriptToEvaluateOnNewDocument", { source: libSources.join("\n;\n") });
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  // ── The reader's own deck, open, with a meta bag on it ────────────────────
  // The import writes its chapter decks straight through saveDeckToLibrary
  // rather than the one-deck-at-a-time editor flow, so it has to put this back
  // afterwards. Establishing it BEFORE the import is what makes the assertion
  // at the end mean anything.
  const OPEN_DECK_TITLE = "The reader's own deck";
  await page.evaluate(`async (title) => {
    const { api, settle } = window.__recall;
    api.state.deckId = null;
    api.state.localDeckId = null;
    api.state.deckTitle = title;
    api.state.deckCategory = "";
    api.state.notes = "A note the reader was in the middle of.";
    api.state.masterCards = [];
    api.state.sourceTitle = title;
    api.state.meta = { bookmark: { blockIndex: 42, at: "2026-01-01T00:00:00.000Z" }, readingPosition: { ratio: 0.5 } };
    await api.saveDeckToLibrary({ silent: true });
    await settle(50);
    return true;
  }`, OPEN_DECK_TITLE);

  // ── 1. The modal opens ───────────────────────────────────────────────────
  //
  // importEpubFile is deliberately NOT awaited: it does not resolve until the
  // modal has been answered. It is parked on window with its rejection caught,
  // so a throw out of the preview — the regression this check exists for —
  // arrives as a readable message instead of an unhandled rejection.
  const opened = await page.evaluate(`async (bytes, name) => {
    const { api, settle } = window.__recall;
    window.__epubError = "";
    const file = new File([new Uint8Array(bytes)], name, { type: "application/epub+zip" });
    window.__epubRun = api.importEpubFile(file, null).catch((error) => {
      window.__epubError = String(error?.message || error);
    });
    for (let i = 0; i < 120 && !document.querySelector(".epub-preview-modal"); i += 1) await settle(50);
    const modal = document.querySelector(".epub-preview-modal");
    return {
      error: window.__epubError,
      open: Boolean(modal),
      title: modal?.querySelector(".epub-preview-title")?.textContent || "",
      author: modal?.querySelector(".epub-preview-author")?.textContent || "",
      chapters: modal?.querySelector(".epub-preview-chapters")?.textContent || "",
      images: modal?.querySelector(".epub-preview-images")?.textContent || ""
    };
  }`, Array.from(fixture.bytes), fileName);

  check("the import preview opens", opened.open,
    opened.open ? "" : `nothing on screen${opened.error ? ` — “${opened.error}”` : ""}`);
  check("...without the import having already failed", !opened.error, opened.error ? `“${opened.error}”` : "no error");
  if (!opened.open) throw new Error(opened.error || "the preview modal never appeared");

  if (fixture.title) {
    check("...naming the book", opened.title === fixture.title, `“${opened.title}”`);
    check("...and its author", opened.author === `by ${fixture.author}`, `“${opened.author}”`);
    // Five chapters out of four spine files: the plan, not the spine, decides.
    check("...counting chapters the plan produced, not the spine's files",
      opened.chapters === String(fixture.chapters.length),
      `${opened.chapters} chapter(s) from ${fixture.spineFiles} spine file(s)`);
    check("...and the figures the manifest carries",
      opened.images === String(fixture.images.length), `${opened.images} image(s)`);
  }

  // ── 2. The figure-quality estimate ───────────────────────────────────────
  // It decodes and re-encodes real images, so it is the one line in the modal
  // that can sit unfinished forever without anything throwing.
  const estimate = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    const line = document.querySelector(".epub-preview-compress-total");
    for (let i = 0; i < 200; i += 1) {
      const text = line?.textContent || "";
      if (text && text !== "Estimating…") break;
      await settle(50);
    }
    return {
      text: line?.textContent || "",
      levels: document.querySelectorAll(".epub-preview-compress .image-compress-level").length,
      selected: document.querySelector(".epub-preview-compress .image-compress-level.is-selected")?.textContent || ""
    };
  }`);
  check("the figure-quality estimate settles", Boolean(estimate.text) && estimate.text !== "Estimating…", `“${estimate.text}”`);
  check("...beside the levels it is an estimate for", estimate.levels > 0, `${estimate.levels} level(s), on “${estimate.selected}”`);

  // ── 3. The chapter list ──────────────────────────────────────────────────
  const listed = await page.evaluate(`async () => {
    const { settle } = window.__recall;
    // The authoritative pass replaces the fast title-only rows with expandable
    // ones; wait for those rather than for the first paint.
    for (let i = 0; i < 300 && !document.querySelector(".epub-preview-chapter"); i += 1) await settle(50);
    return {
      titles: Array.from(document.querySelectorAll(".epub-preview-chapter-name")).map((el) => el.textContent),
      loading: document.querySelector(".epub-preview-toc-loading")?.textContent || ""
    };
  }`);
  if (fixture.numbered) {
    check("the chapter list is the book's own contents",
      JSON.stringify(listed.titles) === JSON.stringify(fixture.numbered),
      listed.titles.length ? listed.titles.join(" · ") : `nothing listed${listed.loading ? ` — “${listed.loading}”` : ""}`);
    check("...including the page the contents does not name",
      listed.titles[0] === fixture.numbered[0], `“${listed.titles[0] || ""}”`);
    check("...and the chapter cut out of the middle of a file",
      listed.titles[3] === fixture.numbered[3], `“${listed.titles[3] || ""}”`);
  } else {
    check("the chapter list is the book's own contents", listed.titles.length > 0, `${listed.titles.length} chapter(s)`);
  }

  // ── 4. A chapter, read in the preview, with its pictures ─────────────────
  //
  // The markers the preview puts in place of hosted URLs are inert fragments;
  // hydrateEpubPreviewImages swaps each for a blob decoded from the zip. A
  // figure whose archive entry is spelled differently from the href pointing at
  // it is the case that goes missing here and nowhere else — the real import
  // resolves it through epubZipFile, so it survives the import while vanishing
  // from the preview of it.
  const readChapter = async (index) => page.evaluate(`async (i) => {
    const { settle } = window.__recall;
    const rows = document.querySelectorAll(".epub-preview-chapter");
    const row = rows[i];
    if (!row) return { missing: true };
    row.querySelector(".epub-preview-chapter-toggle")?.click();
    const body = row.querySelector(".epub-preview-chapter-body");
    for (let n = 0; n < 200; n += 1) {
      if (body && !body.querySelector(".epub-preview-chapter-loading")) break;
      await settle(50);
    }
    // Hydration runs after the render; wait for every marker to become a blob.
    for (let n = 0; n < 200; n += 1) {
      const imgs = body.querySelectorAll("img");
      const pending = Array.from(imgs).filter((img) => !String(img.getAttribute("src") || "").startsWith("blob:"));
      if (imgs.length && !pending.length) break;
      await settle(50);
    }
    const imgs = Array.from(body.querySelectorAll("img"));
    return {
      text: (body.textContent || "").replace(/\\s+/g, " ").trim(),
      images: imgs.length,
      hydrated: imgs.filter((img) => String(img.getAttribute("src") || "").startsWith("blob:")).length
    };
  }`, index);

  if (fixture.chapters) {
    const opening = await readChapter(1);
    check("a chapter expands to its rendered note",
      opening.text.includes(FIXTURE_CHAPTER_MARKERS["Opening the case"]),
      `“${opening.text.slice(0, 60)}…”`);
    check("...with its figure decoded out of the zip",
      opening.images === 1 && opening.hydrated === 1,
      `${opening.hydrated}/${opening.images} shown`);

    // The escapement's figure is `images/fig%201.png` in the markup AND
    // `fig%201.png` in the archive — the spelling only resolveEpubPathRaw finds.
    const escapement = await readChapter(3);
    check("...including one whose archive entry is itself percent-encoded",
      escapement.images === 1 && escapement.hydrated === 1,
      `${escapement.hydrated}/${escapement.images} shown`);
    check("...and the anchored chapter does not repeat its own title",
      !escapement.text.startsWith("The escapement"),
      `“${escapement.text.slice(0, 48)}…”`);
  }

  // ── 5. Import ────────────────────────────────────────────────────────────
  const imported = await page.evaluate(`async (openTitle, folder) => {
    const { api, settle } = window.__recall;
    document.querySelector(".epub-preview-modal [data-epub-confirm]").click();
    await window.__epubRun;
    await settle(300);
    // What the import handed back, read BEFORE anything else opens a deck: the
    // reader's own deck lives in state until something replaces it, and the
    // damage this is watching for is in memory, not in the library. Then save
    // it, which is what the reader's next keystroke would do — that save is
    // where an emptied meta becomes permanent.
    const handedBack = { title: api.state.deckTitle, meta: JSON.parse(JSON.stringify(api.state.meta || null)) };
    await api.saveDeckToLibrary({ silent: true });
    await settle(100);
    const index = api.readLocalDeckIndex();
    const book = index.filter((entry) => entry.category === folder);
    // Reading order, as the import staggers it: chapter 1 newest.
    book.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const notes = [];
    for (const entry of book) {
      await api.loadDeckFromLibrary(entry.id);
      await settle(60);
      notes.push({ title: api.state.deckTitle, category: api.state.deckCategory, markdown: api.state.notes || "" });
    }
    // ...and the library's copy of it, read back after that save.
    const entry = api.readLocalDeckIndex().find((row) => row.title === openTitle);
    let persisted = null;
    if (entry) {
      await api.loadDeckFromLibrary(entry.id);
      await settle(100);
      persisted = { title: api.state.deckTitle, meta: JSON.parse(JSON.stringify(api.state.meta || null)) };
    }
    return {
      error: window.__epubError,
      decks: book.length,
      notes,
      uploaded: window.__recall.uploaded.slice(),
      handedBack,
      persisted
    };
  }`, OPEN_DECK_TITLE, fixture.title || "");

  if (DUMP) {
    console.log(`\n  ── ${imported.uploaded.length} figure(s) uploaded ──`);
    imported.uploaded.forEach((at) => console.log(`     ${at}`));
    imported.notes.forEach((note) => {
      console.log(`\n  ── ${note.title}  (in “${note.category}”) ──`);
      console.log(note.markdown.split("\n").map((line) => `     ${line}`).join("\n"));
    });
    console.log("");
  }

  check("Import writes the book's decks", imported.decks > 0,
    `${imported.decks} deck(s)${imported.error ? ` — “${imported.error}”` : ""}`);

  if (fixture.numbered) {
    check("...one per chapter, in reading order",
      JSON.stringify(imported.notes.map((n) => n.title)) === JSON.stringify(fixture.numbered),
      imported.notes.map((n) => n.title).join(" · "));
    check("...in a folder named after the book",
      imported.notes.every((n) => n.category === fixture.title),
      `“${imported.notes[0]?.category || ""}”`);
    check("...each carrying its own chapter's text",
      fixture.chapters.every((title, i) => (imported.notes[i]?.markdown || "").includes(FIXTURE_CHAPTER_MARKERS[title])),
      fixture.chapters.filter((title, i) => !(imported.notes[i]?.markdown || "").includes(FIXTURE_CHAPTER_MARKERS[title])).join(", ") || "all five");
    check("...with the anchored chapter's duplicated heading dropped",
      !/^#+\s*The escapement/m.test(imported.notes[3]?.markdown || ""),
      `“${(imported.notes[3]?.markdown || "").split("\n")[0].slice(0, 48)}”`);

    // Every figure uploaded once, and every chapter that had one points at a
    // hosted URL rather than at a path inside the zip.
    // Any extension, not just .webp: compressImageToPreset declines the
    // re-encode when it would not save bytes, so a book's smallest plate is
    // legitimately stored as the PNG it arrived as.
    const hosted = imported.notes.flatMap((n) => Array.from(String(n.markdown).matchAll(/https:\/\/example\.supabase\.co\/\S+?\.(?:webp|png|jpe?g|gif)/g)).map((m) => m[0]));
    const distinct = new Set(hosted);
    check("every figure in the book was uploaded once",
      imported.uploaded.length === fixture.images.length && distinct.size === fixture.images.length,
      `${imported.uploaded.length} upload(s), ${distinct.size} distinct URL(s) in the notes`);
    check("...including the two whose names had to be decoded",
      [...distinct].some((url) => url.includes("quiet-machine")) && [...distinct].some((url) => url.includes("fig-1")),
      [...distinct].map((url) => url.split("/").pop()).join(", "));
    // A markdown link OPENING on an in-book path — "](OEBPS/…" or "](images/…"
    // — is a figure that never got a hosted URL and would render broken. The
    // bucket in the hosted URLs is itself called "images", so this has to be
    // anchored on the link's opening paren rather than looking for the word.
    check("...and no figure survived as a path inside the zip",
      !imported.notes.some((n) => /]\((?:\.{0,2}\/)?(?:OEBPS|images)\//.test(n.markdown)),
      "every image src in the notes is a hosted URL");
  }

  // ── 6. The reader's own deck ─────────────────────────────────────────────
  //
  // The import writes its chapter decks straight through saveDeckToLibrary and
  // stamps state.meta = {} for each one, so it has to put the reader's own deck
  // back around the loop. Both halves are asserted because only the second one
  // loses anything: leaving meta out of what is restored is invisible until the
  // NEXT save of that deck writes the empty bag over the real one, taking its
  // bookmark, its reading position and any paper attached to it with it.
  const openMeta = (m) => `bookmark ${m?.bookmark?.blockIndex ?? "—"}, position ${m?.readingPosition?.ratio ?? "—"}`;
  check("the import hands the reader's own deck back",
    imported.handedBack?.title === OPEN_DECK_TITLE, `“${imported.handedBack?.title || ""}”`);
  check("...with the meta it stamped over intact",
    imported.handedBack?.meta?.bookmark?.blockIndex === 42
      && imported.handedBack?.meta?.readingPosition?.ratio === 0.5,
    openMeta(imported.handedBack?.meta));
  check("...so the next save of it does not empty the library's copy",
    imported.persisted?.meta?.bookmark?.blockIndex === 42
      && imported.persisted?.meta?.readingPosition?.ratio === 0.5,
    openMeta(imported.persisted?.meta));

  // ── 7. The whole-book mode ───────────────────────────────────────────────
  const wholeBook = await page.evaluate(`async (bytes, name) => {
    const { api, settle } = window.__recall;
    window.__epubError = "";
    // The first import moved My Decks into the book's own folder, and an import
    // lands wherever My Decks is looking — so a second one would nest inside
    // the first. Back to the root, which is where a reader starting fresh is.
    api.setMyDecksCwd("");
    const before = api.readLocalDeckIndex().map((entry) => entry.id);
    const file = new File([new Uint8Array(bytes)], name, { type: "application/epub+zip" });
    window.__epubRun = api.importEpubFile(file, null).catch((error) => {
      window.__epubError = String(error?.message || error);
    });
    for (let i = 0; i < 300 && !document.querySelector(".epub-preview-modal"); i += 1) await settle(50);
    const modal = document.querySelector(".epub-preview-modal");
    if (!modal) return { error: window.__epubError || "the preview never opened the second time" };
    const book = modal.querySelector('input[name="epub-import-mode"][value="book"]');
    book.checked = true;
    book.dispatchEvent(new Event("change", { bubbles: true }));
    modal.querySelector("[data-epub-confirm]").click();
    await window.__epubRun;
    await settle(300);
    const index = api.readLocalDeckIndex();
    const fresh = index.filter((entry) => !before.includes(entry.id));
    if (fresh.length !== 1) return { error: "", decks: fresh.length, markdown: "", title: "" };
    await api.loadDeckFromLibrary(fresh[0].id);
    await settle(100);
    return { error: window.__epubError, decks: 1, title: api.state.deckTitle, category: api.state.deckCategory, markdown: api.state.notes || "" };
  }`, Array.from(fixture.bytes), fileName);

  check("the whole-book mode saves one deck", wholeBook.decks === 1,
    `${wholeBook.decks} new deck(s)${wholeBook.error ? ` — “${wholeBook.error}”` : ""} “${wholeBook.title || ""}”`);
  if (fixture.numbered && wholeBook.decks === 1) {
    const headings = fixture.numbered.filter((title) => wholeBook.markdown.includes(`## ${title}`));
    check("...with every chapter kept as a heading in it",
      headings.length === fixture.numbered.length, `${headings.length}/${fixture.numbered.length} heading(s)`);
    // One deck means no book folder — the chapter headings ARE the navigation.
    check("...and no folder made for a book that is one deck",
      wholeBook.category !== fixture.title, `filed in “${wholeBook.category}”`);
  }

  // ── An upload that reports success and stores nothing ────────────────────
  //
  // The failure this book's read-back exists for, and the one that is invisible
  // on the importing device: cacheUploadedImageOffline puts the bytes in the
  // service worker's image cache under the same canonical URL the note now
  // holds, so the figure renders here and is a broken-image placeholder on
  // every device the book syncs to. A URL with nothing behind it must not reach
  // the markdown at all — the gap in the chapter is honest, the dead link is
  // not.
  const swallowed = await page.evaluate(`async (bytes, name) => {
    const { api, settle } = window.__recall;
    window.__epubError = "";
    window.__swallowUpload = "0002-";
    api.setMyDecksCwd("");
    const before = api.readLocalDeckIndex().map((entry) => entry.id);
    const file = new File([new Uint8Array(bytes)], name, { type: "application/epub+zip" });
    window.__epubRun = api.importEpubFile(file, null).catch((error) => {
      window.__epubError = String(error?.message || error);
    });
    for (let i = 0; i < 300 && !document.querySelector(".epub-preview-modal"); i += 1) await settle(50);
    const modal = document.querySelector(".epub-preview-modal");
    if (!modal) { window.__swallowUpload = ""; return { error: window.__epubError || "the preview never opened" }; }
    const book = modal.querySelector('input[name="epub-import-mode"][value="book"]');
    book.checked = true;
    book.dispatchEvent(new Event("change", { bubbles: true }));
    modal.querySelector("[data-epub-confirm]").click();
    await window.__epubRun;
    await settle(400);
    window.__swallowUpload = "";
    const index = api.readLocalDeckIndex();
    const fresh = index.filter((entry) => !before.includes(entry.id));
    if (fresh.length !== 1) return { error: window.__epubError, decks: fresh.length, markdown: "" };
    await api.loadDeckFromLibrary(fresh[0].id);
    await settle(100);
    return { error: window.__epubError, decks: 1, markdown: api.state.notes || "" };
  }`, Array.from(fixture.bytes), fileName);

  if (swallowed.decks !== 1) {
    check("a figure the bucket silently dropped is left out of the notes", false,
      `${swallowed.decks} deck(s)${swallowed.error ? ` — “${swallowed.error}”` : ""}`);
  } else {
    const kept = Array.from(String(swallowed.markdown).matchAll(/https:\/\/example\.supabase\.co\/\S+?\.(?:webp|png|jpe?g|gif)/g)).map((m) => m[0]);
    check("a figure the bucket silently dropped is left out of the notes",
      kept.every((url) => !url.includes("0002-")), kept.map((u) => u.split("/").pop()).join(", ") || "no figures at all");
    // ...and the read-back took nothing else with it. A check that only asserts
    // the absence would pass just as happily on an import that dropped the lot.
    // DISTINCT urls: the book puts its cover in two chapters, so counting
    // occurrences would be counting the same surviving figure twice.
    const distinctKept = new Set(kept);
    check("...and the figures that DID land are still there", distinctKept.size === 2,
      `${distinctKept.size} of 2 surviving figure(s)`);
  }

  // ── The folder the warning is about ──────────────────────────────────────
  // Pure, and worth asserting directly: the "already holds N decks" line is the
  // only thing standing between a second import and a silently doubled book,
  // and it used to count whatever folder My Decks happened to be showing rather
  // than the one the book was going to.
  if (fixture.title) {
    const counts = await page.evaluate(`async (bookTitle) => {
      const { api } = window.__recall;
      api.setMyDecksCwd("");
      return {
        here: api.epubTargetFolderDeckCount(bookTitle, null),
        elsewhere: api.epubTargetFolderDeckCount(bookTitle, "Somewhere else")
      };
    }`, fixture.title);
    check("the re-import warning counts the folder the book is going to",
      counts.here === fixture.chapters.length && counts.elsewhere === 0,
      `${counts.here} here, ${counts.elsewhere} in another folder`);
  }

  // ── An import that starts before the converter has arrived ───────────────
  //
  // Last, because it takes Turndown away and does not give it back. Every
  // chapter of a book becomes markdown through htmlToMarkdown, which is
  // synchronous by contract and returns "" when Turndown is not on window; it
  // is a deferred CDN library warmed at idle a couple of seconds after boot, so
  // an import started before that — or on a device where the warm failed — used
  // to convert the entire book to nothing and then report "Could not extract
  // any chapter content from this EPUB". That blames the book for a library
  // that was never there, and it is the same sentence a genuinely unreadable
  // book gets, so the one failure a reader could actually act on was
  // indistinguishable from the one they could not.
  //
  // The CDN is blocked rather than merely absent, so this asserts the same
  // thing on a machine with a route to jsdelivr and on one without.
  await page.call("Network.setBlockedURLs", { urls: ["*cdn.jsdelivr.net*"] });
  const withoutTurndown = await page.evaluate(`async (bytes, name) => {
    const { api, settle } = window.__recall;
    // ASSIGNED, not deleted. The library declares itself with a top-level
    // \`var\` in a classic script, which makes it a non-configurable property of
    // window — \`delete\` silently fails and leaves it exactly where it was, so
    // the import sails past the guard and parks on a modal nobody answers.
    window.TurndownService = undefined;
    window.__epubError = "";
    const status = document.querySelector("#statusText");
    if (status) status.textContent = "";
    const file = new File([new Uint8Array(bytes)], name, { type: "application/epub+zip" });
    const before = api.readLocalDeckIndex().length;
    const run = api.importEpubFile(file, null).catch((error) => {
      window.__epubError = String(error?.message || error);
    });
    // Bounded, because the failure this is watching for is "the import goes on
    // anyway" — and an import that goes on anyway opens a modal and waits for
    // an answer forever. A hang here has to arrive as a named failure rather
    // than as the whole check timing out with nothing on screen.
    const outcome = await Promise.race([run.then(() => "returned"), settle(15000).then(() => "never returned")]);
    const modal = Boolean(document.querySelector(".epub-preview-modal"));
    document.querySelector(".epub-preview-modal [data-epub-cancel]")?.click();
    return {
      outcome,
      error: window.__epubError,
      status: status?.textContent || "",
      modal,
      added: api.readLocalDeckIndex().length - before
    };
  }`, Array.from(fixture.bytes), fileName);

  check("an import with no converter says so, rather than blaming the book",
    /converter/i.test(withoutTurndown.status) && !/chapter content/i.test(withoutTurndown.status),
    `“${withoutTurndown.status}”`);
  check("...and stops before the preview rather than showing an empty one",
    withoutTurndown.outcome === "returned" && !withoutTurndown.modal && withoutTurndown.added === 0,
    `${withoutTurndown.outcome}, ${withoutTurndown.modal ? "modal opened" : "no modal"}, ${withoutTurndown.added} deck(s) written`);
} catch (error) {
  check("the check itself", false, error?.message || String(error));
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.close(); } catch (_) { /* already gone */ }
  try { server.proc.kill(); } catch (_) { /* already gone */ }
}

console.log(failures.length
  ? `\nepub-import-check: ${failures.length} failure(s) — ${failures.join("; ")}`
  : `\nepub-import-check: the preview, its figures, and both import modes all hold`);
process.exit(failures.length ? 1 : 0);
