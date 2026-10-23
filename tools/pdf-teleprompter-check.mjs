// Does the PDF teleprompter read a page in the order it is read, in a real
// browser?
//
//   node tools/pdf-teleprompter-check.mjs            run the cases
//   node tools/pdf-teleprompter-check.mjs --shot     also save pdf-teleprompter.png
//
// The PDF teleprompter (src/documents/pdf-teleprompter.js) scrolls a PDF by
// itself under a reading band, at a speed in words a minute — and, on a page
// set in two columns, down the left column, back UP to the top of the right
// one, and only then on to the next page, with the title and abstract across
// both columns read first. On a phone it zooms so the column fills the width.
// The promise is in the order of these cases: it starts from the ⋯ menu and
// says so; it finds the reading order of a page with text and of a scan with
// none; it moves through a column at about the speed it says; it climbs from
// the foot of the left column to the head of the right one and goes on to the
// next page; the pages ahead keep being drawn while it plays; a press stops it
// in the same tick; Cards pauses it; Escape gives back the reader's own zoom;
// and the bar fits a phone.
//
// Same harness as pdf-preview-check: pdf.js from disk, the app's own modules
// imported into the page, a client that refuses the network, and two PDFs
// built by tools/pdf-fixture.mjs (buildColumnsPdf) — one with text, one a scan.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";
import { PDFJS_VERSION, pdfjsSources, servePdfjsFromDisk } from "./pdfjs-source.mjs";
import { buildColumnsPdf } from "./pdf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SHOT = (args.find((a) => a.startsWith("--shot=")) || "").slice(7)
  || (args.includes("--shot") ? "pdf-teleprompter.png" : "");

const WATCHDOG_MS = 6 * 60 * 1000;

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

const API_SRC = `async () => {
  const paths = [
    "/src/documents/pdf-view.js?v=__BUILD__",
    "/src/documents/pdf-teleprompter.js?v=__BUILD__",
    "/src/import/pdf.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/deck-header.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/reading-rail.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/core/gesture.js?v=__BUILD__",
    "/src/notes/reading-position.js?v=__BUILD__",
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
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("pdf-teleprompter-check does not touch the network"); },
    storage: { from: () => ({
      upload: async () => ({ error: { message: "offline in this check" } }),
      remove: async () => ({ error: null }),
      list: async () => ({ data: [], error: null }),
      createSignedUrls: async () => ({ data: [], error: null }),
      getPublicUrl: (p) => ({ data: { publicUrl: "https://example.supabase.co/storage/v1/object/public/images/" + p } })
    }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  // No countdown, so the cases do not each wait three seconds.
  localStorage.setItem("recall:pdf-teleprompter-v1", JSON.stringify({ countdown: 0 }));
  return true;
}`;

// Imports a PDF and opens it on its PDFs tab, at fit-width.
const OPEN_SRC = `async (bytes, name, title) => {
  const { api, settle } = window.__recall;
  const file = new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
  await api.importPdfFile(file, null);
  await settle(400);
  const entry = api.readLocalDeckIndex().find((m) => m.title === title);
  if (!entry) return { error: "no file titled " + title };
  await api.loadDeckFromLibrary(entry.id);
  await settle(300);
  api.setViewMode("document");
  await settle(200);
  await api.openDocumentView({ force: true });
  await api.whenDocumentPageReady(1);
  // My Files is left open by the sign-in above; a reader opening a PDF from it
  // has closed it.
  api.closeMyDecksPanel();
  await settle(300);
  // At the very top, so the teleprompter starts from the first line — a
  // resumed reading position lands a moment after the open.
  const view = document.getElementById("documentView");
  for (let i = 0; i < 20 && view.scrollTop > 1; i += 1) {
    view.scrollTop = 0;
    await settle(150);
  }
  return { pages: api.currentPdfPageCount(), viewMode: api.state.viewMode, top: view.scrollTop };
}`;

const chrome = findChrome();
if (!chrome) { console.log("pdf-teleprompter-check: no Chrome on this machine — skipping."); process.exit(0); }

let sources;
try {
  sources = pdfjsSources();
} catch (error) {
  console.log(`pdf-teleprompter-check: could not obtain pdf.js ${PDFJS_VERSION} (${error?.message || error}) — skipping.`);
  process.exit(0);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
let ran = 0;
async function check(name, fn) {
  ran += 1;
  let detail = null;
  try { detail = await fn(); } catch (error) { detail = String(error.message || error); }
  if (detail) failures.push({ name, detail });
  console.log(`${detail ? "FAIL" : "ok  "}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

const snap = () => page.evaluate(`() => window.__recall.api.pdfTeleprompterSnapshot()`);

// "F L R" from a page's reading path, two full stretches in a row shown as one.
const ORDER_SRC = `async (pageNumber) => {
  const { api, settle } = window.__recall;
  let path = null;
  for (let i = 0; i < 100 && !path; i += 1) {
    path = api.pdfTeleprompterPath(pageNumber);
    if (!path) await settle(100);
  }
  if (!path) return null;
  const letters = path.segments.map((s) => (s.kind === "full" ? "F" : s.x0 < 0.45 ? "L" : "R"))
    .filter((letter, index, all) => !(letter === "F" && all[index - 1] === "F"));
  return { order: letters.join(" "), source: path.source, columns: path.columns };
}`;

// Sets a number in the ⚙ sheet the way a reader types it: the box, then change.
const setNumber = (key, value) => page.evaluate(`(key, value) => {
  const box = document.querySelector('#documentStage [data-tp-number="' + key + '"]');
  if (!box) return false;
  box.value = String(value);
  box.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`, key, value);

const waitPhase = (phase, timeout = 8000) => page.waitFor(
  `() => window.__recall.api.pdfTeleprompterSnapshot()?.phase === ${JSON.stringify(phase)}`,
  { timeout, label: `the PDF teleprompter to be ${phase}` }
);

// The cursor's walk, sampled: every change of segment, with where the view
// was when it changed.
const WATCH_SRC = `async (ms, stopAt) => {
  const view = document.getElementById("documentView");
  const seen = [];
  const t0 = performance.now();
  let last = "";
  while (performance.now() - t0 < ms) {
    const s = window.__recall.api.pdfTeleprompterSnapshot();
    if (!s) break;
    const key = s.cursor ? s.cursor.page + ":" + s.cursor.index : "none";
    if (key !== last && s.segment) {
      const entry = { page: s.cursor.page, index: s.cursor.index, kind: s.segment.kind, x0: s.segment.x0, scale: s.scale, climb: 0 };
      const from = view.scrollTop;
      seen.push(entry);
      last = key;
      // Where the glide to it takes the view, once it has had time to land.
      setTimeout(() => { entry.climb = Math.round(view.scrollTop - from); }, 900);
      if (stopAt && s.cursor.page === stopAt.page && s.cursor.index >= stopAt.index) break;
    }
    if (s.phase === "ended") break;
    await new Promise((r) => setTimeout(r, 40));
  }
  return seen;
}`;

try {
  await emulatePhone(page);
  await page.call("Page.addScriptToEvaluateOnNewDocument", {
    source: `${sources.main}
;(function () {
  try {
    var blob = new Blob([${JSON.stringify(sources.worker)}], { type: "text/javascript" });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  } catch (e) { console.warn("check: could not install the pdf.js worker", e); }
})();`
  });
  await servePdfjsFromDisk(client, page, sources);
  await page.goto(`${server.base}/index.html`);
  await page.evaluate(SETUP_SRC, API_SRC);

  const paper = buildColumnsPdf({ pages: 3 });
  const opened = await page.evaluate(OPEN_SRC, Array.from(paper.bytes), "columns.pdf", paper.title);
  if (opened.error) throw new Error(opened.error);
  if (opened.pages !== 3 || opened.viewMode !== "document" || opened.top > 1) throw new Error(`opened ${JSON.stringify(opened)}`);

  // ── Starting it ──────────────────────────────────────────────────────────
  await check("⋯ → Teleprompter on a PDF is a switch that reads Off, and pressing it opens a session", async () => {
    const before = await page.evaluate(`() => {
      const row = document.querySelector('#documentMoreMenu [data-document-action="teleprompter"]');
      return row ? { pressed: row.getAttribute("aria-pressed"), slot: row.dataset.slot, label: row.textContent } : null;
    }`);
    if (!before) return "no Teleprompter row in the PDF's ⋯ menu";
    if (before.pressed !== "false") return `the row reads aria-pressed=${before.pressed} with nothing running`;
    if (before.slot !== "doc") return `the row is shown on ${before.slot}, not only on a PDF`;
    await page.evaluate(`() => {
      document.getElementById("documentMoreBtn").click();
      document.querySelector('#documentMoreMenu [data-document-action="teleprompter"]').click();
    }`);
    await sleep(300);
    const after = await page.evaluate(`() => {
      const bar = document.querySelector("#documentStage > .tp-bar");
      const pager = document.getElementById("documentPager");
      return {
        active: window.__recall.api.pdfTeleprompterActive(),
        pressed: document.querySelector('#documentMoreMenu [data-document-action="teleprompter"]').getAttribute("aria-pressed"),
        rail: document.querySelector('#readingRailTray [data-rail-action="pdf-teleprompter"]')?.getAttribute("aria-pressed"),
        bar: Boolean(bar && bar.getBoundingClientRect().height > 30),
        sizeHidden: bar?.querySelector(".tp-size")?.hidden === true,
        pager: pager ? getComputedStyle(pager).display : "none",
        menuClosed: document.getElementById("documentMoreMenu").hidden
      };
    }`);
    if (!after.active) return "pressing the row did not start a session";
    if (after.pressed !== "true") return "the switch still reads Off";
    if (after.rail !== "true") return `the rail's copy reads ${after.rail}`;
    if (!after.bar) return "no bar on screen";
    if (!after.sizeHidden) return "the bar offers A−/A+, which mean nothing on a PDF";
    if (after.pager !== "none") return "the page control is still over the foot of the page, under the bar";
    if (!after.menuClosed) return "the ⋯ menu stayed open";
    return null;
  });

  await check("a page with text: title and abstract first, then the left column, then the right", async () => {
    const first = await page.evaluate(ORDER_SRC, 1);
    const second = await page.evaluate(ORDER_SRC, 2);
    if (!first) return "page 1's reading path never arrived";
    if (first.source !== "text") return `page 1 was read from its ${first.source}, not its text`;
    if (first.order !== "F L R") return `page 1 reads ${first.order}`;
    if (second?.order !== "L R") return `page 2 reads ${second?.order}`;
    return null;
  });

  await check("from the top of the PDF it starts on the first line of page 1", async () => {
    await waitPhase("playing");
    await page.waitFor(`() => window.__recall.api.pdfTeleprompterSnapshot()?.segment`, { timeout: 15000, label: "a segment" });
    const s = await snap();
    if (s.cursor.page !== 1 || s.cursor.index !== 0) return `started on page ${s.cursor.page}, segment ${s.cursor.index}`;
    if (s.segment.kind !== "full") return `the first stretch is a ${s.segment.kind}, not the title across the page`;
    return null;
  });

  await check("it plays, and on a phone a column is zoomed to fill the width", async () => {
    await setNumber("wpm", 3000);
    await page.waitFor(`() => window.__recall.api.pdfTeleprompterSnapshot()?.segment?.kind === "column"
      && !window.__recall.api.pdfTeleprompterSnapshot().holding`, { timeout: 60000, label: "the first column" });
    await setNumber("wpm", 200);
    const s = await snap();
    if (s.cursor.page !== 1) return `the first column read was on page ${s.cursor.page}`;
    if (!(s.scale > s.baseScale * 1.4)) return `reading a column at ${s.scale.toFixed(2)}, the reader's own zoom was ${s.baseScale.toFixed(2)}`;
    const flag = await page.evaluate(`() => window.__recall.api.documentAutoScrolling()`);
    if (!flag) return "documentAutoScrolling() is false while it plays — rendering would be held back for the whole session";
    return null;
  });

  await check("through a column at about the words a minute it says", async () => {
    // Out of any glide first.
    await page.waitFor(`() => { const s = window.__recall.api.pdfTeleprompterSnapshot(); return s && !s.gliding && !s.holding && s.cursor.t < 0.7; }`,
      { timeout: 20000, label: "a steady stretch" });
    const measured = await page.evaluate(`async () => {
      const api = window.__recall.api;
      const a = api.pdfTeleprompterSnapshot();
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 2000));
      const b = api.pdfTeleprompterSnapshot();
      const seconds = (performance.now() - t0) / 1000;
      if (a.cursor.index !== b.cursor.index || a.cursor.page !== b.cursor.page) return { moved: "segment" };
      const wordsRead = (b.cursor.t - a.cursor.t) * a.segment.words;
      return { wpm: (wordsRead / seconds) * 60, asked: a.wpm };
    }`);
    if (measured.moved) return "the cursor left its segment during the sample";
    const ratio = measured.wpm / measured.asked;
    if (ratio < 0.7 || ratio > 1.3) return `read ${measured.wpm.toFixed(0)} wpm, the session asked for ${measured.asked}`;
    return null;
  });

  await check("from the foot of the left column it climbs to the head of the right, then on to the next page", async () => {
    await setNumber("wpm", 5000);
    const walk = await page.evaluate(WATCH_SRC, 45000, { page: 2, index: 1 });
    const steps = walk.map((w) => `${w.page}:${w.kind === "full" ? "F" : w.x0 < 0.45 ? "L" : "R"}`);
    const right = walk.findIndex((w) => w.page === 1 && w.kind === "column" && w.x0 > 0.45);
    const onToTwo = walk.findIndex((w) => w.page === 2);
    if (right < 0) return `never reached page 1's right column: ${steps.join(" ")}`;
    if (onToTwo < 0 || onToTwo < right) return `never went on to page 2 after the right column: ${steps.join(" ")}`;
    const left = walk[right - 1];
    if (!left || left.kind !== "column" || left.x0 > 0.45) return `the right column did not follow the left: ${steps.join(" ")}`;
    await sleep(1000);
    if (steps.slice(onToTwo).some((step) => step.startsWith("1:"))) return `went back to page 1 after page 2: ${steps.join(" ")}`;
    // The view went UP to start the right column: the glide's first frames
    // are above where the foot of the left column was read.
    if (!(walk[right].climb < -100)) return `the view moved ${walk[right].climb}px going to the right column, not up`;
    return null;
  });

  await check("in the path, the head of the right column is above the foot of the left", async () => {
    const tops = await page.evaluate(`async () => {
      const api = window.__recall.api;
      const s = api.pdfTeleprompterSnapshot();
      const path = api.pdfTeleprompterPath(1);
      const left = path.segments.find((x) => x.kind === "column" && x.x0 < 0.45);
      const right = path.segments.find((x) => x.kind === "column" && x.x0 > 0.45);
      return { leftEnd: left.y1, rightStart: right.y0, page: s.cursor.page };
    }`);
    if (!(tops.rightStart < tops.leftEnd - 0.3)) return `right column starts at ${tops.rightStart.toFixed(2)}, left ends at ${tops.leftEnd.toFixed(2)}`;
    return null;
  });

  await check("the pages it scrolls to are drawn while it plays", async () => {
    const drawn = await page.evaluate(`async () => {
      const view = document.getElementById("documentView");
      await new Promise((r) => setTimeout(r, 1200));
      const box = view.getBoundingClientRect();
      const y = box.top + box.height * 0.4;
      const pageEl = [...document.querySelectorAll(".pdf-page")].find((p) => {
        const r = p.getBoundingClientRect();
        return r.top <= y && r.bottom >= y;
      });
      return pageEl ? { page: pageEl.dataset.pageNumber, drawn: Boolean(pageEl.querySelector(".pdf-canvas, .pdf-picture")) } : null;
    }`);
    if (!drawn) return "no page under the band";
    if (!drawn.drawn) return `page ${drawn.page} is under the band with nothing drawn on it`;
    return null;
  });

  await check("a press on the page stops it before the button comes up", async () => {
    await setNumber("wpm", 200);
    if ((await snap()).phase !== "playing") await page.evaluate(`() => window.__recall.api.resumePdfTeleprompter()`);
    await sleep(600);
    const point = await page.evaluate(`() => {
      const box = document.getElementById("documentView").getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height * 0.55) };
    }`);
    await page.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    const during = await snap();
    await page.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    if (during.phase !== "paused") return `still ${during.phase} with the finger down`;
    if (during.pauseReason !== "reader") return `paused for "${during.pauseReason}"`;
    return null;
  });

  await check("▶ carries on from the line under the band", async () => {
    const before = await snap();
    await page.evaluate(`() => window.__recall.api.resumePdfTeleprompter()`);
    await sleep(500);
    const after = await snap();
    if (after.phase !== "playing") return `phase ${after.phase}`;
    if (after.cursor.page !== before.cursor.page) return `jumped from page ${before.cursor.page} to ${after.cursor.page}`;
    return null;
  });

  await check("going to Cards pauses it; coming back finds it paused, not gone", async () => {
    await page.evaluate(`async () => { window.__recall.api.setViewMode("cards"); await window.__recall.settle(600); }`);
    const away = await snap();
    await page.evaluate(`async () => { window.__recall.api.setViewMode("document"); await window.__recall.settle(600); }`);
    const back = await snap();
    if (!away || away.phase !== "paused" || away.pauseReason !== "away") return `on Cards: ${JSON.stringify(away && { phase: away.phase, reason: away.pauseReason })}`;
    if (!back) return "the session ended on the way back";
    return null;
  });

  await check("the bar fits a 390px phone", async () => {
    const fit = await page.evaluate(`() => {
      const bar = document.querySelector("#documentStage > .tp-bar");
      const r = bar.getBoundingClientRect();
      return { left: r.left, right: r.right, width: innerWidth };
    }`);
    if (fit.left < 0 || fit.right > fit.width) return `the bar runs ${fit.left.toFixed(0)}..${fit.right.toFixed(0)} on a ${fit.width}px screen`;
    return null;
  });

  if (SHOT) {
    await page.evaluate(`() => window.__recall.api.resumePdfTeleprompter()`);
    await sleep(800);
    const shot = await page.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.resolve(SHOT), Buffer.from(shot.data, "base64"));
    console.log(`      screenshot: ${SHOT}`);
  }

  // The column's zoom is the teleprompter's, not the reader's. Saved as theirs,
  // it was what the PDF reopened at whenever a session ended without its own
  // exit — the app closed, a file switch, a sync reopening the paper.
  await check("while a column is zoomed, the place saved for the PDF keeps the reader's own zoom", async () => {
    const seen = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const view = document.getElementById("documentView");
      view.scrollTop += 40;
      view.dispatchEvent(new Event("scroll"));
      await settle(400);
      api.flushReadingPositionSave();
      // The module itself, for its live openPdf: the api copies values once.
      const pv = await import("/src/documents/pdf-view.js?v=__BUILD__");
      const stored = api.readStoredReadingPosition(api.documentPositionKey(pv.openPdf.slot, null));
      const s = api.pdfTeleprompterSnapshot();
      return { saved: stored ? stored.scale : null, fit: stored ? stored.fitWidth : null, applied: pv.openPdf.scale, base: s.baseScale };
    }`);
    if (!(seen.applied > seen.base * 1.2)) return `no column zoom to test (applied ${seen.applied}, the reader's ${seen.base})`;
    if (seen.saved == null) return "nothing was saved";
    if (Math.abs(seen.saved - seen.base) > 0.01) return `saved zoom ${seen.saved.toFixed(2)}, the reader's own is ${seen.base.toFixed(2)} (the column's ${seen.applied.toFixed(2)})`;
    if (seen.fit !== true) return "saved without Fit width, which the reader had on";
    return null;
  });

  await check("Escape gives back the reader's own zoom, and the PDF as it was", async () => {
    const s = await snap();
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(500);
    const after = await page.evaluate(`() => ({
      active: window.__recall.api.pdfTeleprompterActive(),
      scale: window.__recall.api.openPdf?.scale,
      fit: window.__recall.api.isDocumentFitWidth(),
      cls: document.getElementById("documentView").classList.contains("is-teleprompter")
        || document.getElementById("documentStage").classList.contains("is-teleprompter"),
      lead: document.getElementById("documentView").style.getPropertyValue("--tp-lead"),
      bar: Boolean(document.querySelector("#documentStage > .tp-bar")),
      pressed: document.querySelector('#documentMoreMenu [data-document-action="teleprompter"]').getAttribute("aria-pressed")
    })`);
    if (after.active) return "Escape did not leave the teleprompter";
    if (Math.abs(after.scale - s.baseScale) > 0.01) return `zoom ${after.scale.toFixed(2)}, the reader had ${s.baseScale.toFixed(2)}`;
    if (!after.fit) return "the PDF no longer follows the window width, as it did before";
    if (after.cls || after.lead || after.bar) return "the teleprompter left something behind on the PDF";
    if (after.pressed !== "false") return "the switch still reads On";
    return null;
  });

  // What the Notes teleprompter does to this one when it takes the panel from
  // behind another tab. The zoom used to be put back there and then, under
  // display:none, and the reader came back to the old scrollTop on pages half
  // the size — pages further on.
  await check("ended from behind another tab, the PDF comes back on the same page at the reader's zoom", async () => {
    const started = await page.evaluate(`() => window.__recall.api.startPdfTeleprompter()`);
    if (!started) return "it would not start again";
    await setNumber("wpm", 3000);
    await page.waitFor(`() => { const s = window.__recall.api.pdfTeleprompterSnapshot(); return s && s.segment?.kind === "column" && !s.holding && s.scale > s.baseScale * 1.2; }`,
      { timeout: 60000, label: "a zoomed column" });
    await setNumber("wpm", 200);
    const seen = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      api.pausePdfTeleprompter("reader");
      await settle(400);
      const base = api.pdfTeleprompterSnapshot().baseScale;
      const page = api.currentDocumentPage();
      api.setViewMode("cards");
      await settle(400);
      api.exitPdfTeleprompter({ land: false });
      await settle(300);
      api.setViewMode("document");
      await settle(1200);
      const pv = await import("/src/documents/pdf-view.js?v=__BUILD__");
      const view = document.getElementById("documentView");
      // A short PDF at the reader's zoom cannot put its last page at the top:
      // the view stops at its end, with that page on screen.
      const atEnd = view.scrollTop >= view.scrollHeight - view.clientHeight - 2;
      const pageBox = view.querySelector('.pdf-page[data-page-number="' + page + '"]')?.getBoundingClientRect();
      const viewBox = view.getBoundingClientRect();
      const pageOnScreen = Boolean(pageBox && pageBox.top < viewBox.bottom && pageBox.bottom > viewBox.top);
      return { page, base, after: api.currentDocumentPage(), atEnd, pageOnScreen, scale: pv.openPdf.scale, fit: api.isDocumentFitWidth() };
    }`);
    if (seen.after !== seen.page && !(seen.atEnd && seen.pageOnScreen)) return `left on page ${seen.page}, came back on page ${seen.after}`;
    if (Math.abs(seen.scale - seen.base) > 0.01) return `zoom ${seen.scale.toFixed(2)} on coming back, the reader had ${seen.base.toFixed(2)}`;
    if (!seen.fit) return "the PDF no longer follows the window width";
    return null;
  });

  // ── A scan ─────────────────────────────────────────────────────────────────
  const scan = buildColumnsPdf({ pages: 2, scanned: true });
  const scanned = await page.evaluate(OPEN_SRC, Array.from(scan.bytes), "scan.pdf", scan.title);
  if (scanned.error) throw new Error(scanned.error);

  await check("a scan with no text: the columns are found in the picture, and read in order", async () => {
    const started = await page.evaluate(`() => window.__recall.api.startPdfTeleprompter()`);
    if (!started) return "it would not start on the scan";
    const first = await page.evaluate(ORDER_SRC, 1);
    if (!first) return "the scan's reading path never arrived";
    if (first.source !== "ink") return `read from its ${first.source}`;
    if (first.order !== "F L R") return `the scan reads ${first.order}`;
    return null;
  });

  await check("...and plays through it, left column then right", async () => {
    await setNumber("wpm", 5000);
    const walk = await page.evaluate(WATCH_SRC, 40000, { page: 1, index: 99 });
    const steps = walk.map((w) => `${w.page}:${w.kind === "full" ? "F" : w.x0 < 0.45 ? "L" : "R"}`);
    const left = steps.indexOf("1:L");
    const right = steps.indexOf("1:R");
    if (left < 0 || right < 0 || right < left) return `walked ${steps.join(" ")}`;
    return null;
  });

  await page.evaluate(`() => window.__recall.api.exitPdfTeleprompter()`);
} catch (error) {
  failures.push({ name: "the check itself", detail: String(error?.stack || error) });
  console.log(`FAIL  the check itself\n        ${error?.stack || error}`);
} finally {
  clearTimeout(watchdog);
  try { client.close(); } catch (_) { /* already gone */ }
  try { launched.proc.kill(); } catch (_) { /* already gone */ }
  try { server.proc.kill(); } catch (_) { /* already gone */ }
}

console.log(`\nCHECK: ${ran} cases · ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
