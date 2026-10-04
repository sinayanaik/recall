// Does highlighting leave the words where they were?
//
//   node tools/repaint-stability-check.mjs
//
// A highlight is an edit to the note's markdown, and the edited block is rebuilt
// as a new element (see patchRenderedBlocks in src/render/block-cache.js). Three
// things about that rebuild used to move the page under the reader, and each is
// asserted here frame by frame rather than at the end — a jump that snaps back
// 150ms later has a net displacement of zero and is exactly what was reported:
//
//   1. The fresh block arrived with `content-visibility: auto` and no remembered
//      size. On a code block whose top was above the viewport the browser's own
//      scroll anchoring (its anchor had been inside the removed <pre>) mis-moved
//      the view on the first frame, and settleNotesPin undid it a confirm-pass
//      later: text up 15px, then back.
//   2. The rebuilt <pre> / table wrap started at scrollLeft 0, so a highlight in a
//      code line or table cell scrolled sideways snapped back to the left edge.
//   3. The placement walk detached and re-inserted EVERY block after the edited
//      one, which cost each of them its own scroll position too.
//
// Measured on the glass (getBoundingClientRect of the highlighted text), both
// axes, at a desktop and a phone width.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = findChrome();

if (!CHROME) {
  console.error("repaint-stability-check: no Chrome. Set CHROME_PATH — see tools/cdp.mjs.");
  console.log("CHECK: 1 checks · 1 failed");
  process.exit(1);
}

// How far the highlighted words may move on screen, in any frame, on either axis.
const TOLERANCE_PX = 2;

let ran = 0;
let failures = 0;
function check(condition, name, detail = "") {
  ran += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${name}${detail ? `  [${detail}]` : ""}`);
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

// Runs INSIDE the page.
const PROBE = async (cases) => {
  const paths = [
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/format/highlight.js?v=__BUILD__",
    "/src/format/render-toolbar.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("repaint-stability-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Repaint stability fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(300);

  const para = (i) => `Para ${i} alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo.`;
  const lines = ["# Repaint stability", ""];
  for (let i = 0; i < 60; i += 1) lines.push(para(i), "");
  // Tall, with lines far wider than any viewport: the block that jumped.
  lines.push("```js");
  for (let i = 0; i < 60; i += 1) lines.push(`const value${i} = compute(${i}); // QQ${i}QQ ${"x".repeat(i % 3 === 0 ? 220 : 10)} TAIL${i}`);
  lines.push("```", "");
  for (let i = 60; i < 90; i += 1) lines.push(para(i), "");
  lines.push(`| ${Array.from({ length: 14 }, (_, c) => `Head${c}`).join(" | ")} |`, `|${" --- |".repeat(14)}`);
  for (let r = 0; r < 40; r += 1) lines.push(`| ${Array.from({ length: 14 }, (_, c) => `TT${r}x${c}TT wide cell`).join(" | ")} |`);
  lines.push("");
  for (let i = 90; i < 120; i += 1) lines.push(para(i), "");
  lines.push(Array.from({ length: 12 }, (_, q) => `> Quote line QT${q}QT alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike`).join("\n>\n"), "");
  lines.push(Array.from({ length: 50 }, (_, q) => `Long paragraph LP${q}LP alpha bravo charlie delta echo.`).join(" "), "");
  for (let i = 120; i < 180; i += 1) lines.push(para(i), "");
  const source = lines.join("\n");

  const view = document.getElementById("notesView");
  const textRange = (needle) => {
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.data.indexOf(needle);
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      return range;
    }
    return null;
  };
  const scrollerOf = (needle) => textRange(needle)?.startContainer.parentElement.closest("pre, .markdown-table-wrap") || null;
  const topLevelOf = (node) => {
    let at = node;
    while (at && at.parentElement !== view) at = at.parentElement;
    return at;
  };

  const results = [];
  for (const { name, needle, at, sideways, remove } of cases) {
    api.state.notes = source;
    await api.renderNotesView();
    await settle(700);
    const viewTop = view.getBoundingClientRect().top;
    const aim = async () => {
      for (let k = 0; k < 6; k += 1) {
        const rect = textRange(needle).getBoundingClientRect();
        view.scrollTop += rect.top - viewTop - at;
        await settle(120);
      }
    };
    await aim();
    if (sideways) {
      scrollerOf(needle).scrollLeft = sideways;
      await settle(100);
      await aim();
    }
    const select = () => {
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(textRange(needle));
    };
    const target = api.renderTargetConfig("notes");
    if (remove) {
      // Highlight it first, then take it off again: the overlap path.
      select();
      api.makeHighlightFromSelection(target, "yellow");
      await settle(900);
      await aim();
      if (sideways) scrollerOf(needle).scrollLeft = sideways;
      await settle(200);
    }

    const glass = () => {
      const rect = textRange(needle)?.getBoundingClientRect();
      return rect ? { x: rect.left, y: rect.top - viewTop } : null;
    };
    select();
    await settle(250);
    const before = glass();
    const scrollerBefore = scrollerOf(needle)?.scrollLeft ?? 0;

    // The blocks after the edited one must be left alone, not detached and put back.
    const edited = topLevelOf(textRange(needle).startContainer);
    const followers = [];
    for (let node = edited?.nextElementSibling; node && followers.length < 6; node = node.nextElementSibling) followers.push(node);
    let followersRemoved = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) if (followers.includes(node)) followersRemoved += 1;
    });
    observer.observe(view, { childList: true });

    let worst = { dx: 0, dy: 0, t: 0 };
    let stop = false;
    const t0 = performance.now();
    const tick = () => {
      if (stop) return;
      const now = glass();
      if (now) {
        const dx = Math.abs(now.x - before.x);
        const dy = Math.abs(now.y - before.y);
        if (Math.max(dx, dy) > Math.max(worst.dx, worst.dy)) worst = { dx, dy, t: Math.round(performance.now() - t0) };
      }
      requestAnimationFrame(tick);
    };
    const outcome = api.makeHighlightFromSelection(target, "yellow");
    requestAnimationFrame(tick);
    await settle(900);
    stop = true;
    observer.disconnect();
    results.push({
      name,
      action: outcome?.action || null,
      worst: { dx: Math.round(worst.dx), dy: Math.round(worst.dy), t: worst.t },
      scrollerBefore,
      scrollerAfter: scrollerOf(needle)?.scrollLeft ?? 0,
      sideways: Boolean(sideways),
      followers: followers.length,
      followersRemoved,
      freshLeft: view.querySelectorAll("[data-fresh-block]").length
    });
  }
  return results;
};

// ── A short note, on an engine without scroll anchoring ────────────────────
//
// The Gayatri Mantra report, on an iPhone: a note that fits on one screen, one
// phrase per line, an annotated note on most words. "The first time I highlight
// after opening the note, the note text scrolls somewhere else; after that it
// doesn't." Safari has no CSS scroll anchoring, which every repaint-stability
// measure above leans on, so `overflow-anchor: none` stands in for it.
//
// Also what that note showed about the badges (numbers then): the first line's were cut off
// (paint containment), and "10" stacked as "1" over "0".
const SHORT_NOTE = [
  "## Gayatri Mantra",
  "",
  "ॐ <mark data-note=\"hn-a1\">भू</mark><mark data-color=\"green\" data-note=\"hn-a2\">र्भुवः</mark> <mark data-note=\"hn-a3\">स्वः</mark>",
  "<mark data-note=\"hn-a4\">तत्</mark><mark data-color=\"green\" data-note=\"hn-a5\">सवितुर्</mark>वरेण्यं",
  "<mark data-color=\"blue\" data-note=\"hn-a6\">भर्गो</mark> <mark data-color=\"green\" data-note=\"hn-a7\">देवस्य</mark> <mark data-color=\"green\" data-note=\"hn-a8\">धीमहि</mark>।",
  "<mark data-note=\"hn-a9\">धियो</mark> <mark data-note=\"hn-b1\">यो</mark> <mark data-note=\"hn-b2\">नः</mark> <mark data-note=\"hn-b3\">प्रचोदयात्</mark>॥",
  "",
  "उस प्राणस्वरूप, दुःखनाशक, सुखस्वरूप, श्रेष्ठ, तेजस्वी, पापनाशक, देवस्वरूप परमात्मा को हम अपनी अन्तरात्मा में धारण करें।"
].join("\n");

const PROBE_SHORT = async (note) => {
  const paths = [
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/format/highlight.js?v=__BUILD__",
    "/src/format/highlight-notes.js?v=__BUILD__",
    "/src/format/render-toolbar.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("repaint-stability-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Mantras", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(300);
  document.querySelectorAll(".toast").forEach((t) => t.remove());

  let source = note;
  ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "b1", "b2", "b3"].forEach((id, i) => {
    source = api.setHighlightNoteInSource(source, "hn-" + id, "note " + (i + 1), "x");
  });
  const view = document.getElementById("notesView");
  view.style.overflowAnchor = "none";
  api.state.notes = source;
  await api.renderNotesView();
  await settle(500);
  const out = {};

  out.contained = [...view.children].filter((b) => getComputedStyle(b).contentVisibility === "auto").length;
  const badges = [...view.querySelectorAll(".hl-note-badge")];
  out.badges = badges.length;
  // The 1st and the 10th fold: the same few pixels, and no text in either.
  const one = badges[0];
  const ten = badges[9];
  if (one && ten) {
    const a = one.getBoundingClientRect();
    const b = ten.getBoundingClientRect();
    out.sameSize = { w1: Math.round(a.width * 10) / 10, h1: Math.round(a.height * 10) / 10, w10: Math.round(b.width * 10) / 10, h10: Math.round(b.height * 10) / 10, text: one.textContent + ten.textContent };
  }
  out.hidden = badges.map((badge, i) => [badge, i + 1]).filter(([badge]) => {
    const r = badge.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== badge;
  }).map(([, i]) => i);

  // The folds move no letter: every highlight is where it would be without them.
  const para = view.querySelector("p");
  const lineWidths = () => [...para.querySelectorAll("mark")]
    .map((m) => { const r = m.getBoundingClientRect(); return Math.round(r.left * 10) / 10 + "-" + Math.round(r.right * 10) / 10; })
    .join(",");
  const withBadges = lineWidths();
  badges.forEach((b) => { b.style.display = "none"; });
  const without = lineWidths();
  badges.forEach((b) => { b.style.display = ""; });
  out.shaping = { withBadges, without };

  // The first highlight after opening the note: nothing moves.
  const textRange = (needle) => {
    const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement.closest(".hl-note-badge")) continue;
      const at = n.data.indexOf(needle);
      if (at === -1) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + needle.length);
      return r;
    }
    return null;
  };
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(textRange("दुःखनाशक"));
  await settle(250);
  const probeNeedle = "धारण";
  const before = textRange(probeNeedle).getBoundingClientRect();
  const scrollBefore = view.scrollTop;
  let worst = 0;
  let maxScroll = 0;
  let stop = false;
  const tick = () => {
    if (stop) return;
    const r = textRange(probeNeedle)?.getBoundingClientRect();
    if (r) worst = Math.max(worst, Math.abs(r.top - before.top), Math.abs(r.left - before.left));
    maxScroll = Math.max(maxScroll, Math.abs(view.scrollTop - scrollBefore));
    requestAnimationFrame(tick);
  };
  const result = api.makeHighlightFromSelection(api.renderTargetConfig("notes"), "yellow");
  requestAnimationFrame(tick);
  await settle(900);
  stop = true;
  out.action = result?.action || null;
  out.worst = Math.round(worst * 10) / 10;
  out.maxScroll = maxScroll;
  return out;
};

const CASES = [
  { name: "a tall code block whose top is above the viewport", needle: "QQ30QQ", at: 200 },
  { name: "a code line scrolled sideways", needle: "QQ33QQ", at: 200, sideways: 150 },
  { name: "taking a highlight off a code line scrolled sideways", needle: "QQ36QQ", at: 200, sideways: 150, remove: true },
  { name: "a table cell scrolled sideways", needle: "TT20x6TT", at: 200, sideways: 300 },
  { name: "a quote", needle: "QT8QT", at: 200 },
  { name: "a long paragraph", needle: "LP40LP", at: 150 }
];

async function run() {
  const server = await serveOn(ROOT);
  const browser = await launch({ executablePath: CHROME });
  const errors = [];
  try {
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      const page = await browser.newPage();
      page.on?.("pageerror", (error) => errors.push(String(error?.message || error)));
      await page.setViewport({ width, height });
      await page.goto(`${server.base}/index.html`);
      await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 60000 });
      if (!(await page.evaluate(() => Boolean(window.marked && window.DOMPurify)))) {
        check(false, "markdown libraries loaded");
        await page.close();
        continue;
      }
      await new Promise((r) => setTimeout(r, 1500));
      const results = await page.evaluate(PROBE, CASES);
      for (const r of results) {
        const label = `${width}px · ${r.name}`;
        const expected = r.name.startsWith("taking") ? "removed" : "added";
        check(r.action === expected, `${label}: the highlight was ${expected}`, `action ${r.action}`);
        check(r.worst.dx <= TOLERANCE_PX && r.worst.dy <= TOLERANCE_PX,
          `${label}: the words stay put`,
          `worst frame moved ${r.worst.dx}px across, ${r.worst.dy}px down at +${r.worst.t}ms`);
        if (r.sideways) {
          check(r.scrollerAfter === r.scrollerBefore, `${label}: keeps its sideways scroll`,
            `scrollLeft ${r.scrollerBefore} → ${r.scrollerAfter}`);
        }
        check(r.followers > 0 && r.followersRemoved === 0, `${label}: the blocks after it are not moved`,
          `${r.followersRemoved} of ${r.followers} detached`);
        check(r.freshLeft === 0, `${label}: no block is left marked fresh`, `${r.freshLeft} still marked`);
      }
      await page.close();
    }
    {
      const page = await browser.newPage();
      page.on?.("pageerror", (error) => errors.push(String(error?.message || error)));
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await page.goto(`${server.base}/index.html`);
      await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 60000 });
      await new Promise((r) => setTimeout(r, 1500));
      const r = await page.evaluate(PROBE_SHORT, SHORT_NOTE);
      const label = "390px · a short annotated Devanagari note";
      check(r.contained === 0, `${label}: no block keeps content-visibility containment`, `${r.contained} contained`);
      check(r.badges === 12, `${label}: every annotated highlight wears its fold`, `${r.badges} badges`);
      check(Boolean(r.sameSize) && r.sameSize.w1 === r.sameSize.w10 && r.sameSize.h1 === r.sameSize.h10 && r.sameSize.text === "",
        `${label}: the 10th fold is the 1st one's size, with no number in either`, JSON.stringify(r.sameSize));
      check(r.hidden.length === 0, `${label}: no fold is clipped or covered`, r.hidden.length ? `hidden: #${r.hidden.join(",")}` : "all visible");
      check(r.shaping.withBadges === r.shaping.without, `${label}: the folds move no highlight by a pixel`,
        `${r.shaping.withBadges} vs ${r.shaping.without}`);
      check(r.action === "added", `${label}: the first highlight after opening it is made`, `action ${r.action}`);
      check(r.worst <= TOLERANCE_PX && r.maxScroll === 0, `${label}: and nothing moves, with no scroll anchoring to hide it`,
        `worst ${r.worst}px, scrolled ${r.maxScroll}px`);
      await page.close();
    }
    check(errors.length === 0, "no uncaught exceptions", errors.slice(0, 3).join(" | ") || "clean");
  } finally {
    await browser.close();
    server.proc.kill();
  }
}

await run();
console.log(failures ? `\n${failures} failed` : "\nall good");
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
