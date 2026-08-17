// Does the caret ribbon sit where the caret is, and stay still when it should?
//
//   node tools/ribbon-check.mjs
//
// The band drawn behind the caret's line in the raw editor (.notes-caret-line)
// was reported as "not accurate nor stable — it flickers even if I am on the
// same line, and it is not staying in the correct location where the caret is".
//
// Both halves are measurable, and neither is a pure function: the band's
// position comes from a Range measured inside the highlight mirror, so it only
// means anything once a browser has laid the mirror out. Hence a real editor
// with real typing.
//
// The three things that made it move when it should not have:
//   • the measurement silently fell back to a wholly different ESTIMATE
//     whenever the mirror could not answer (a mid-rebuild mirror, which is most
//     of the time while typing), so the band snapped between two answers;
//   • the mirror rebuild and the band's own measurement were each scheduled on
//     their own requestAnimationFrame, so which one ran first — and therefore
//     whether the band measured the text before or after the keystroke — was
//     down to callback order;
//   • `transition: top` turned any of that into continuous motion, and made the
//     band lag a tenth of a second behind the text on every scroll frame.

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
if (!puppeteer || !CHROME) { console.log("ribbon-check: no puppeteer/Chrome — skipping."); process.exit(0); }

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
    from: () => { throw new Error("ribbon-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Ribbon fixture", notesMode: true });
  await settle(500);

  const ta = document.getElementById("notesEdit");
  if (!ta) return [{ name: "setup", ok: false, detail: "no #notesEdit in the page" }];

  // A note with many distinct lines, small enough to keep the mirror on.
  //
  // Leave the editor BEFORE writing state.notes, never after: a notes-mode deck
  // opens straight into the raw editor, and commitNotesEditIfActive() copies the
  // textarea's value INTO state.notes — so committing after assigning the
  // fixture replaced it with the new deck's empty string. The probe then ran
  // every case against a blank note, where a band that never moves is correct
  // and the whole file passes for the wrong reason.
  const lines = Array.from({ length: 200 }, (_, i) => "Line " + (i + 1) + " of the ribbon fixture note, long enough to be a real line of prose.");
  api.commitNotesEditIfActive();
  await settle(200);
  api.state.notes = lines.join("\\n");
  await api.renderNotesView();
  await settle(300);
  api.enterNotesEditing(0);
  await settle(500);
  if (!ta.value.includes("\\n")) return [{ name: "setup", ok: false, detail: "the fixture note never reached the editor (" + ta.value.length + " chars, no line breaks)" }];
  if (ta.hidden) return [{ name: "setup", ok: false, detail: "the raw editor never opened" }];

  const band = () => document.querySelector(".notes-caret-line");
  const bandTop = () => {
    const b = band();
    if (!b || b.hidden) return null;
    return b.getBoundingClientRect().top;
  };
  // Where the caret ACTUALLY is on screen, measured independently of anything
  // the band did — a Range inside the mirror, which is the same ground truth
  // the editor itself relies on for alignment.
  const caretTop = (pos) => {
    const hit = api.caretRectInBackdrop(ta, pos);
    return hit ? hit.rect.top : null;
  };

  // Put the caret in the middle of the note, where there is room to move in
  // both directions and the editor has definitely scrolled.
  const midLine = 60;
  // Read off the LIVE value, never the fixture array. The typing case below
  // inserts characters, so an offset computed from the original lines points a
  // dozen characters earlier than it names — which silently landed the "next
  // line" case back on the SAME line, where a band that correctly did not move
  // read as a band that failed to move.
  const offsetOfLine = (n) => {
    const value = ta.value;
    let at = 0;
    for (let i = 0; i < n; i += 1) {
      const nl = value.indexOf("\\n", at);
      if (nl === -1) return at;
      at = nl + 1;
    }
    return at;
  };

  // Two ways to move the caret, and the difference matters.
  //
  // jumpTo is the app's own entry point: it SCROLLS the caret into view.
  // Needed for the first placement, because setSelectionRange alone does not
  // scroll — the caret ends up 1600px below the visible box and the band
  // correctly hides itself, which reads as "the band never appeared".
  //
  // moveTo is an ordinary caret move with no scrolling, used for the
  // adjacent-line case. Jumping there instead would scroll by exactly one line
  // to put the caret back on the reading line, leaving the band at the same
  // screen position — a real move that measures as no move at all.
  const jumpTo = async (pos) => {
    ta.focus();
    // revealNotesCaretAt only SCROLLS and draws — it does not place the caret
    // (enterNotesEditing sets the selection itself before calling it). Without
    // this the selection stayed at 0 and every keystroke below was typed at the
    // top of the note while the view sat sixty lines down.
    ta.setSelectionRange(pos, pos);
    api.revealNotesCaretAt(pos);
    await settle(300);
  };
  const moveTo = async (pos) => {
    ta.focus();
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event("select"));
    await settle(200);
  };

  await jumpTo(offsetOfLine(midLine) + 10);
  const startTop = bandTop();
  push("the band is drawn for a caret in a laid-out note", startTop == null ? "the band never appeared" : true);

  push("the band sits on the caret's own line", (() => {
    const caret = caretTop(ta.selectionStart);
    if (caret == null) return "the mirror could not report the caret position";
    if (startTop == null) return "the band never appeared";
    // Same line box: the band is drawn at the line's top, the caret rect starts
    // there too. A whole line height apart means it is on the wrong line.
    if (Math.abs(startTop - caret) > 6) return "band at " + Math.round(startTop) + ", caret at " + Math.round(caret);
    return true;
  })());

  // ── Typing along one line must not move it ──────────────────────────────
  push("typing on one line leaves the band still", await (async () => {
    if (startTop == null) return "the band never appeared";
    const before = bandTop();
    const seen = new Set();
    for (let i = 0; i < 12; i += 1) {
      const at = ta.selectionStart;
      ta.setRangeText("x", at, at, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
      await settle(60);
      const top = bandTop();
      if (top != null) seen.add(Math.round(top));
    }
    const after = bandTop();
    if (after == null) return "the band disappeared while typing";
    // One position for the whole run. Two means it moved and came back, which
    // is what "it flickers even if I am on the same line" describes.
    if (seen.size > 1) return "the band took " + seen.size + " different positions while typing on one line: " + [...seen].join(", ");
    if (Math.abs(after - before) > 2) return "moved " + Math.round(after - before) + "px";
    return true;
  })());

  // ── Moving a line must move it, by about a line ─────────────────────────
  push("moving to the next line moves the band one line", await (async () => {
    const before = bandTop();
    await moveTo(offsetOfLine(midLine + 1) + 10);
    const after = bandTop();
    if (before == null || after == null) return "the band was not drawn for one of the two lines";
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    const moved = after - before;
    const why = " [caret " + ta.selectionStart + ", caretTop " + Math.round(caretTop(ta.selectionStart) || -1) +
                ", bandBefore " + Math.round(before) + ", bandAfter " + Math.round(after) +
                ", lineOf60 " + offsetOfLine(60) + ", lineOf61 " + offsetOfLine(61) + "]";
    if (moved < lineHeight * 0.5) return "moved only " + Math.round(moved) + "px for a line height of " + Math.round(lineHeight) + why;
    if (moved > lineHeight * 2.5) return "moved " + Math.round(moved) + "px for a line height of " + Math.round(lineHeight);
    return true;
  })());

  // ── Scrolling must not leave it behind ──────────────────────────────────
  push("the band tracks the text exactly while scrolling", await (async () => {
    const pos = ta.selectionStart;
    const before = bandTop();
    const caretBefore = caretTop(pos);
    if (before == null || caretBefore == null) return "nothing to measure";
    // UP, not down. revealNotesCaretAt parks the caret near the top of the box
    // (the reading line), so scrolling down by any useful amount pushes it off
    // the top edge — where the band correctly hides itself, and the case has
    // nothing left to measure. Scrolling up moves the caret's line further DOWN
    // the visible box, which is where it has to stay to be compared.
    ta.scrollTop -= 100;
    ta.dispatchEvent(new Event("scroll"));
    // ONE frame. A CSS transition on the band's top would still be animating
    // here, which is exactly the lag this asserts against — the band must be
    // repositioned by arithmetic, not tweened.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const after = bandTop();
    const caretAfter = caretTop(pos);
    if (after == null || caretAfter == null) return "the band or the caret left the box";
    const drift = (after - before) - (caretAfter - caretBefore);
    if (Math.abs(drift) > 2) return "the band drifted " + Math.round(drift) + "px away from its text in one frame";
    return true;
  })());

  // ── Plain mode: past the mirror threshold ───────────────────────────────
  push("a jump's band survives typing in a note too big for the mirror", await (async () => {
    api.commitNotesEditIfActive();
    await settle(200);
    // Over HIGHLIGHT_MIRROR_MAX_CHARS (60,000), so the mirror switches off.
    const big = Array.from({ length: 1200 }, (_, i) => "Line " + (i + 1) + " of a note far too large for the syntax mirror to be worth laying out twice.");
    api.state.notes = big.join("\\n");
    await api.renderNotesView();
    await settle(300);
    const at = big.slice(0, 400).reduce((sum, l) => sum + l.length + 1, 0) + 10;
    api.enterNotesEditing(at);
    await settle(600);
    const before = bandTop();
    if (before == null) return "no band was drawn on arrival in plain mode";
    // Type on the same line. The band used to be retired outright by the first
    // keystroke here (there is no mirror to re-measure against), which is the
    // other half of "the ribbon is not stable".
    for (let i = 0; i < 5; i += 1) {
      const cur = ta.selectionStart;
      ta.setRangeText("y", cur, cur, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true }));
      await settle(60);
    }
    const after = bandTop();
    if (after == null) return "the band vanished on the first keystroke";
    if (Math.abs(after - before) > 2) return "moved " + Math.round(after - before) + "px while typing on one line";
    return true;
  })());

  api.commitNotesEditIfActive();
  return results;
}`;

const API_SRC = `async () => {
  const mods = await Promise.all([
    import("/src/notes/caret.js?v=__BUILD__"),
    import("/src/notes/caret-line.js?v=__BUILD__"),
    import("/src/notes/notes-view.js?v=__BUILD__"),
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
    // BEFORE navigation, not after. index.html pulls marked/DOMPurify/KaTeX from
    // a CDN, and injecting them once the page has already loaded is too late:
    // the app's own boot has run by then, thrown on the missing globals, and
    // left half its wiring undone — initToolbars in particular, which is what
    // builds the raw editor's highlight mirror. Everything measured here then
    // measures an app that never finished starting. Same evaluateOnNewDocument
    // + request-abort pair tools/ui-smoke.mjs uses, for the same reason.
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

  // Retried once for a launch that never happened — see the same note in
  // tools/paged-check.mjs. A probe that ran is returned as-is.
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
  if (results == null) throw launchError || new Error("ribbon-check could not run");

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  if (errors.length) console.log(`  page errors: ${errors.slice(0, 3).join(" | ")}`);
  console.log(`\n${results.length} ribbon cases · ${failed.length} failed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  for (const s of servers) s.kill();
}
