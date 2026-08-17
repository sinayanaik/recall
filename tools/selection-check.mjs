// Is selecting text in a note precise?
//
//   node tools/selection-check.mjs
//   node tools/selection-check.mjs --shot out.png   # screenshot each case
//
// Reported as "selecting text misselects a lot, and sometimes UI control text
// gets selected". Every other check in here tests a function; selection is not
// a function. It is what the browser does when a pointer is dragged across a
// layout, and the only way to know what it does is to drag one.
//
// So: boot the real app against the stand-in backend from tools/ui-smoke.mjs,
// render a note with known, uniquely-marked paragraphs, then perform real mouse
// drags through the CDP input domain — press, twenty-odd moves, release — and
// read back what ended up selected. Each case asserts something a person would
// notice, not an implementation detail.
//
// Every point a drag aims at is measured off the thing it means to hit — a
// character's own rect, the midpoint between two buttons — never as an offset
// from some enclosing box. Three separate false alarms came out of ignoring
// that, each of which looked exactly like a serious app bug:
//
//   • "paragraph.top + height/2" is the SEAM between a wrapped paragraph's two
//     lines. Dragging along it makes Chrome re-place the caret on every move
//     instead of extending: zero characters, in a build that is perfect.
//   • "paragraph.left + 40px" is not a place, it is a guess near some glyph.
//     One such guess landed on an x where headless Chrome will not start a
//     selection drag at all — reproducible at 116.5, fine at 115.5 and 117.5,
//     with the same caret offset for all three.
//   • the floating pill is a 999px-radius pill, so its bounding box's CORNERS
//     are outside the shape and belong to the note behind it. Pressing one is
//     a press on the note, and the selection is supposed to go away.

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = process.argv.includes("--shot");
const CHROME = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium", "/snap/bin/chromium",
].find(existsSync);
function loadPuppeteer() {
  for (const base of [ROOT, "/home/san/.nvm/versions/node/v22.19.0/lib/node_modules/@mermaid-js/mermaid-cli/"]) {
    try { return createRequire(path.join(base, "x.js"))("puppeteer"); } catch (_) { /* next */ }
  }
  return null;
}
const puppeteer = loadPuppeteer();
if (!puppeteer || !CHROME) { console.log("selection-check: no puppeteer/Chrome — skipping."); process.exit(0); }

const VENDORED = [
  "recall-clipper/vendor/marked.min.js",
  "recall-clipper/vendor/purify.min.js",
  "recall-clipper/vendor/katex/katex.min.js",
  "recall-clipper/vendor/katex/auto-render.min.js",
].map((p) => path.join(ROOT, p));

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

// Enough of a backend to get past sign-in; nothing here is ever read back.
const FAKE = String.raw`() => {
  const q = () => { const s = { single: false };
    const a = { select: () => a, insert: () => a, upsert: () => a, update: () => a, delete: () => a,
      eq: () => a, neq: () => a, in: () => a, order: () => a, range: () => a, limit: () => a,
      abortSignal: () => a, single: () => (s.single = true, a), maybeSingle: () => (s.single = true, a),
      then: (res, rej) => Promise.resolve(s.single ? { data: null, error: { code: "PGRST116" } } : { data: [], error: null }).then(res, rej) };
    return a; };
  const user = { id: "user-1", email: "you@example.com" };
  return { from: q,
    auth: { getSession: async () => ({ data: { session: { user, access_token: "t" } }, error: null }),
            getUser: async () => ({ data: { user }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
            signOut: async () => ({ error: null }) },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }),
      upload: async () => ({ data: null, error: { message: "offline" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) } };
}`;

const MODULE_API = `async () => {
  const mods = await Promise.all([
    import("/src/cloud/supabase-client.js?v=__BUILD__"), import("/src/boot.js?v=__BUILD__"),
    import("/src/ui/boot-screens.js?v=__BUILD__"), import("/src/ui/view-mode.js?v=__BUILD__"),
    import("/src/notes/notes-view.js?v=__BUILD__"), import("/src/core/state.js?v=__BUILD__"),
    import("/src/cards/new-deck.js?v=__BUILD__"), import("/src/notes/anchors.js?v=__BUILD__")
  ]);
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// Uniquely-marked paragraphs, so an assertion can say WHICH text was selected,
// plus the two blocks that carry their own furniture: a code fence (copy
// button, labelled with the language) and a table.
function probeNote() {
  const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");
  const out = ["# Probe note", ""];
  for (let i = 0; i < 60; i++) {
    if (i === 12) out.push("```js", "const copyMe = 1;", "console.log(copyMe);", "```", "");
    if (i === 20) out.push("| Element | Symbol |", "| --- | --- |", "| Hydrogen | H |", "");
    out.push(`P${String(i).padStart(2, "0")} ${words.join(" ")} ${words.slice(0, 8).join(" ")}.`, "");
  }
  return out.join("\n");
}

// Everything a case needs to know about the live selection, in one read.
const READ_SELECTION = () => {
  const s = window.getSelection();
  if (!s || s.rangeCount === 0) return { len: 0, text: "", anchorIn: null, focusIn: null, tags: [] };
  const range = s.getRangeAt(0);
  const where = (node) => {
    const e = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!e) return null;
    if (e.closest("#notesView")) return "notes";
    if (e.closest(".notes-head")) return "notes-head";
    if (e.closest(".appbar")) return "appbar";
    if (e.closest(".selection-float")) return "pill";
    return "elsewhere";
  };
  const holder = document.createElement("div");
  holder.appendChild(range.cloneContents());
  return {
    len: s.toString().length,
    text: s.toString().replace(/\s+/g, " ").trim(),
    anchorIn: where(s.anchorNode),
    focusIn: where(s.focusNode),
    tags: Array.from(holder.querySelectorAll("*")).map((n) => n.tagName).filter((t, i, a) => a.indexOf(t) === i),
  };
};

const server = await serveOn(ROOT);
await new Promise((r) => setTimeout(r, 900));
const browser = await puppeteer.launch({ headless: "new", executablePath: CHROME, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const failures = [];
// Counted, not written down. The summary line used to carry a literal "7", so
// adding a case left it reporting the old number — a check whose own tally can
// go stale is a check nobody can trust the tally of.
const ran = { count: 0 };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 800 });
  await page.setRequestInterception(true);
  page.on("request", (r) => (r.url().includes("cdn.jsdelivr.net") ? r.abort() : r.continue()));
  for (const lib of VENDORED) if (existsSync(lib)) await page.evaluateOnNewDocument(readFileSync(lib, "utf8"));
  await page.goto(`${server.base}/index.html`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForFunction(() => !document.documentElement.classList.contains("app-booting"), { timeout: 30000 }).catch(() => {});

  await page.evaluate(async (apiSrc, fakeSrc, note) => {
    const api = await (0, eval)(apiSrc)();
    window.__api = api;
    api.setSupabaseClient((0, eval)("(" + fakeSrc + ")")());
    api.setSignedIn(true);
    api.showAuthenticatedUI();
    api.initAppForUser();
    await new Promise((r) => setTimeout(r, 500));
    api.createNewDeck({ title: "Probe", notesMode: true });
    await new Promise((r) => setTimeout(r, 400));
    api.state.notes = note;
    api.setViewMode("notes");
    await new Promise((r) => setTimeout(r, 300));
    // createNewDeck opens the raw editor for an empty note; this case is about
    // the RENDERED view, which is where a reader actually selects.
    api.resetNotesEditingUI();
    // Awaited, and then waited on for real geometry. A fixed sleep here is what
    // made this file fail in bursts when the suite runs it after several other
    // headless browsers: the render had not finished, every case measured an
    // unlaid-out paragraph, and ten assertions failed at once as though the app
    // were broken.
    await api.renderNotesView();
  }, MODULE_API, FAKE, probeNote());

  await page.waitForFunction(() => {
    const view = document.querySelector("#notesView");
    return Boolean(view) && !view.hidden && view.clientWidth > 200 && view.querySelectorAll("p").length > 10;
  }, { timeout: 45000 });

  const stage = await page.evaluate(() => ({
    blocks: document.querySelector("#notesView")?.children.length || 0,
    view: document.querySelector("#notesView")?.getBoundingClientRect().toJSON(),
    head: document.querySelector(".notes-head")?.getBoundingClientRect().toJSON(),
    copyLabel: document.querySelector("#notesView .code-copy-btn")?.textContent || "",
  }));
  if (!stage.blocks) throw new Error("the probe note did not render");

  // The centre of character `index` of paragraph `marker`, scrolled into view.
  //
  // Measured off a Range around that one character rather than as an offset
  // from the paragraph's box, because "paragraph.left + 40px" is not a place —
  // it is a guess that happens to be near some glyph. One such guess landed on
  // an x where headless Chrome refuses to start a selection drag at all
  // (reproducible at 116.5, fine at 115.5 and 117.5, same caret offset for all
  // three), which reads exactly like a catastrophic app bug and is not one.
  // A character's own rect has a real interior, and its vertical middle is a
  // line rather than the seam between two.
  // Measured AFTER the scroll has actually happened, not in the same task as the
  // request for it. scrollIntoView only schedules the scroll; reading a rect
  // immediately afterwards can return the pre-scroll position, and a drag aimed
  // there lands on whatever is really at those coordinates — usually nothing
  // selectable. That is the intermittent "every drag selected 0 characters" run
  // this file has been producing, which looks exactly like the app being broken
  // and is not. Two frames plus a settled-position check, then measure.
  const charIn = async (marker, index, tries = 10) => {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const at = await charInOnce(marker, index);
      if (at) return at;
      // Under load the scroll can still be settling, or a re-render can have
      // replaced the paragraph between the scroll and the measure. Retrying is
      // about the HARNESS reaching a stable state, never about giving the app
      // another go: the assertions below are unchanged either way. Backs off,
      // because the slow case is a machine that has just finished running
      // another headless browser, not one that needs another 250ms.
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
    return null;
  };

  const charInOnce = async (marker, index) => {
    const found = await page.evaluate((m) => {
      const p = Array.from(document.querySelectorAll("#notesView p")).find((n) => n.textContent.trim().startsWith(m));
      if (!p) return false;
      p.scrollIntoView({ block: "center" });
      return true;
    }, marker);
    if (!found) return null;
    // Wait for scrollTop to stop changing — a smooth or interrupted scroll can
    // still be in flight a frame later.
    await page.evaluate(async () => {
      const view = document.querySelector("#notesView");
      let last = NaN;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => requestAnimationFrame(r));
        if (view.scrollTop === last) return;
        last = view.scrollTop;
      }
    });
    return page.evaluate(({ m, i }) => {
      const p = Array.from(document.querySelectorAll("#notesView p")).find((n) => n.textContent.trim().startsWith(m));
      if (!p) return null;
      const text = p.firstChild;
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getBoundingClientRect();
      // Off-screen after all: aiming a drag here would press on whatever is at
      // those coordinates instead, so say so rather than return a bad point.
      if (r.bottom < 0 || r.top > window.innerHeight || !r.width) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { m: marker, i: index });
  };

  // Drop whatever is selected AND wait for the floating pill to go with it.
  // The pill is positioned just below the last selection and is a real element
  // over the note, so a case that presses where the previous case's pill still
  // is measures the pill, not the note — every drag comes back empty and the
  // run reads like a catastrophic selection bug that isn't there. Its hide runs
  // off the 160ms selectionchange debounce, so this waits for the element
  // rather than guessing at a sleep.
  async function clearSelection() {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.waitForFunction(() => document.querySelector("#selectionFloat")?.hidden !== false, { timeout: 3000 });
  }

  async function dragTo(from, to, steps = 30) {
    await clearSelection();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await new Promise((r) => setTimeout(r, 14));
    }
    await new Promise((r) => setTimeout(r, 450));
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate(READ_SELECTION);
  }

  let shot = 0;
  async function check(name, run) {
    let got = null;
    let problem = null;
    ran.count += 1;
    try { problem = await run(); } catch (e) { problem = `threw: ${e.message}`; }
    if (SHOT) await page.screenshot({ path: `/tmp/selection-${String(shot++).padStart(2, "0")}.png` });
    console.log(`  ${problem ? "FAIL" : "ok  "}  ${name}${problem ? ` — ${problem}` : ""}`);
    if (problem) failures.push(name);
    return got;
  }

  // Wait for the fixture to be MEASURABLE, not merely present. `stage.blocks`
  // only says the note rendered; a case aims at a character's own rect, and
  // under load (the suite runs this straight after several other headless
  // browsers) the layout can still be settling when the first drag is measured.
  // Every case then fails at once with an unmeasurable point, which reads as a
  // catastrophic selection bug and is the harness not being ready.
  const ready = await (async () => {
    for (let i = 0; i < 60; i += 1) {
      const at = await charInOnce("P05", 4);
      if (at) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  })();
  if (!ready) throw new Error("the probe note never became measurable — the harness was not ready, so no case ran");

  console.log("── selecting text in a rendered note ──");

  await check("a drag inside one paragraph selects that paragraph's text", async () => {
    const at = await charIn("P05", 4);
    const to = await charIn("P05", 40);
    const sel = await dragTo(at, to);
    if (sel.len < 10) return `selected ${sel.len} characters`;
    if (sel.anchorIn !== "notes" || sel.focusIn !== "notes") return `ends up in ${sel.anchorIn}/${sel.focusIn}`;
    if (!/alpha bravo/.test(sel.text)) return `selected ${JSON.stringify(sel.text.slice(0, 60))}`;
    return null;
  });

  await check("dragging UP out of the notes keeps the selection", async () => {
    const at = await charIn("P30", 4);
    const sel = await dragTo(at, { x: at.x, y: stage.head.top + 6 });
    // The failure this exists for: the selection collapsed to nothing and
    // re-anchored inside the header's "Study Notes" label.
    if (sel.len === 0) return "the selection collapsed to nothing";
    if (sel.anchorIn !== "notes") return `the anchor moved to ${sel.anchorIn}`;
    if (/Study Notes|CARDS|NOTES|HIGHLIGHTS/.test(sel.text)) return `header text is in the selection: ${JSON.stringify(sel.text.slice(0, 60))}`;
    return null;
  });

  await check("dragging DOWN past the bottom edge selects only note text", async () => {
    const at = await charIn("P05", 4);
    const sel = await dragTo(at, { x: at.x + 280, y: stage.view.bottom + 120 }, 40);
    if (sel.len < 200) return `selected only ${sel.len} characters`;
    // What the range CONTAINS is not the question — Range.cloneContents()
    // hands back the raw DOM and knows nothing about user-select, so a
    // <button> shows up in it either way. What the user sees highlighted and
    // gets on the clipboard is Selection.toString(), and that is what has to
    // be free of the app's furniture.
    if (stage.copyLabel && sel.text.includes(stage.copyLabel)) return `the code block's copy button (${JSON.stringify(stage.copyLabel)}) is in the selected text`;
    if (/Study Notes|Reveal clozes|Make card/.test(sel.text)) return `control text is in the selection: ${JSON.stringify(sel.text.slice(0, 60))}`;
    return null;
  });

  await check("a selection across a code block excludes its copy button", async () => {
    const at = await charIn("P11", 4);
    const sel = await dragTo(at, { x: at.x + 200, y: at.y + 220 }, 30);
    if (!/copyMe/.test(sel.text)) return "the drag missed the code block";
    if (!stage.copyLabel) return "the code block rendered without its copy button — nothing was tested";
    if (sel.text.includes(stage.copyLabel)) {
      return `the copy button's label ${JSON.stringify(stage.copyLabel)} is in the selection`;
    }
    return null;
  });

  await check("the top bar and the ☰ drawer are not selectable", async () => {
    const sel = await dragTo({ x: 40, y: 40 }, { x: 700, y: 60 }, 25);
    // The drawer is only pushed off-screen when closed, never hidden — before
    // this was fixed a drag here returned its entire contents, 369 characters
    // of every button in the app.
    if (sel.len > 0) return `selected ${sel.len} characters: ${JSON.stringify(sel.text.slice(0, 80))}`;
    return null;
  });

  // ── When the pill appears, and where ──────────────────────────────────────
  //
  // Reported as "the text options spawn almost immediately after I start
  // selecting, before I've finished selecting, and block the actual content".
  // Both halves are checked here because both were true: the bar came up on a
  // 160ms debounce mid-drag, and it was positioned below the selection, over
  // the lines about to be read.

  await check("the pill stays away while the drag is still going", async () => {
    await clearSelection();
    const from = await charIn("P05", 4);
    const to = await charIn("P05", 40);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 20, from.y + ((to.y - from.y) * i) / 20);
      await new Promise((r) => setTimeout(r, 14));
    }
    // Well past the 160ms debounce that used to put it on screen here.
    await new Promise((r) => setTimeout(r, 450));
    const shown = await page.evaluate(() => {
      const p = document.querySelector("#selectionFloat");
      return Boolean(p && !p.hidden);
    });
    const selected = await page.evaluate(() => (window.getSelection()?.toString() || "").length);
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 400));
    if (!selected) return "the drag selected nothing, so nothing was actually tested";
    if (shown) return "the pill appeared mid-drag, on an unfinished selection";
    const after = await page.evaluate(() => {
      const p = document.querySelector("#selectionFloat");
      return Boolean(p && !p.hidden);
    });
    if (!after) return "the pill never appeared after the drag was released";
    return null;
  });

  await check("the pill sits above the selection, not over what comes next", async () => {
    const at = await charIn("P05", 4);
    await dragTo(at, await charIn("P05", 40), 20);
    const geo = await page.evaluate(() => {
      const p = document.querySelector("#selectionFloat");
      if (!p || p.hidden) return null;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const b = p.getBoundingClientRect();
      return { pillBottom: b.bottom, pillTop: b.top, selTop: r.top, selBottom: r.bottom, innerHeight: window.innerHeight };
    });
    if (!geo) return "the pill never appeared for a live selection";
    // Above by preference. Below is only correct when there was no room above,
    // which this fixture (a paragraph well down the note) does not produce.
    if (geo.pillBottom > geo.selTop + 1) {
      return `the pill covers the text after the selection (pill ${Math.round(geo.pillTop)}-${Math.round(geo.pillBottom)}, selection starts ${Math.round(geo.selTop)})`;
    }
    return null;
  });

  await check("pressing the floating pill keeps the selection it acts on", async () => {
    const at = await charIn("P30", 4);
    const before = await dragTo(at, await charIn("P30", 60), 20);
    // The gap between the first two buttons: a spot that is unambiguously ON
    // the pill and on none of its controls, which is what a thumb finds when
    // it misses. Measured from the buttons rather than from the pill's box,
    // whose corners are outside the 999px radius and belong to the note.
    const gap = await page.evaluate(() => {
      const p = document.querySelector("#selectionFloat");
      if (!p || p.hidden) return null;
      const btns = Array.from(p.querySelectorAll(".selection-float-btn"))
        .filter((b) => !b.hidden)
        .map((b) => b.getBoundingClientRect());
      if (btns.length < 2) return null;
      return { x: (btns[0].right + btns[1].left) / 2, y: (btns[0].top + btns[0].bottom) / 2 };
    });
    if (!gap) return "the pill never appeared for a live selection";
    await page.mouse.move(gap.x, gap.y);
    await page.mouse.down();
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 250));
    const after = await page.evaluate(READ_SELECTION);
    if (after.text !== before.text) {
      return `the selection changed from ${before.len} characters to ${after.len}`;
    }
    return null;
  });
  // The card faces are the other surface people select on, and they sit
  // directly above the Review / Prev / Add / Next / Known row — a much shorter
  // reach than the notes header, and on the face of it the same hazard.
  //
  // It was not: this case passed before the chrome was made unselectable, and
  // still does. The card face is its own overflow:auto box and Chrome will not
  // extend a selection out of it into the row below. Kept as a guard, since
  // nothing about that is guaranteed and the row is one CSS change away from
  // being reachable.
  await check("a card answer selects without pulling in the button row", async () => {
    await page.evaluate(async () => {
      const api = window.__api;
      api.addCardFromNotes(
        "What does this card ask?",
        "P99 alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike."
      );
      api.setViewMode("cards");
      await new Promise((r) => setTimeout(r, 700));
    });
    const face = await page.evaluate(() => {
      const view = document.querySelector("#questionView");
      const controls = document.querySelector(".controls");
      if (!view || view.hidden) return null;
      const t = view.querySelector("p")?.firstChild;
      if (!t) return null;
      const range = document.createRange();
      range.setStart(t, 2);
      range.setEnd(t, 3);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, controlsTop: controls.getBoundingClientRect().top };
    });
    if (!face) return "the card face did not render";
    const sel = await dragTo({ x: face.x, y: face.y }, { x: face.x + 60, y: face.controlsTop + 20 }, 30);
    if (sel.len === 0) return "the selection collapsed to nothing";
    if (/Review|Prev|Known|Shuffle|Restart/.test(sel.text)) {
      return `the button row is in the selection: ${JSON.stringify(sel.text.slice(0, 70))}`;
    }
    return null;
  });

  // Reported as "bundle bold, italic, underline, code, strikethrough, text
  // colour inside a separate nested item because I rarely use them". Nine
  // controls sat across the bar in front of the ones that get used.
  await check("the rarely-used formatting is behind one control", async () => {
    const bar = await page.evaluate(() => {
      const slot = document.getElementById("selectionFloatFormat");
      if (!slot) return null;
      const menu = slot.querySelector(".render-text-style-menu");
      return {
        topLevelActions: [...slot.children]
          .map((n) => n.dataset.renderAction || (n.dataset.renderSplit ? "split:" + n.dataset.renderSplit : n.tagName))
          .filter(Boolean),
        hasMenu: Boolean(menu),
        menuActions: menu ? [...menu.querySelectorAll("[data-render-action]")].map((b) => b.dataset.renderAction) : [],
        menuColours: menu ? menu.querySelectorAll("[data-render-color]").length : 0,
        menuFonts: menu ? menu.querySelectorAll("[data-render-font]").length : 0,
      };
    });
    if (!bar) return "the formatting slot is not in the page";
    if (!bar.hasMenu) return "there is no text-style popover";
    for (const action of ["bold", "italic", "underline", "strikethrough", "code"]) {
      if (!bar.menuActions.includes(action)) return `${action} is not inside the popover`;
      if (bar.topLevelActions.includes(action)) return `${action} is still on the bar itself`;
    }
    if (bar.menuColours < 12) return `only ${bar.menuColours} colours in the popover`;
    if (bar.menuFonts < 16) return `only ${bar.menuFonts} fonts in the popover`;
    // Bulletify is an ACTION and stays out in front — that is the whole point
    // of moving the styling in.
    if (!bar.topLevelActions.includes("bulletify")) return "bulletify is not on the bar";
    return null;
  });

  // Reported as: "it is annoying that when I click go to in highlights I am
  // taken to the right place but the text formatting options come up
  // unnecessarily". revealRenderedNoteRange deliberately SELECTS the span it
  // jumped to, so the browser's own highlight shows exactly where you landed —
  // and that is a real selectionchange, so the pill followed it up.
  await check("a Go to jump lands without raising the formatting bar", async () => {
    const ok = await page.evaluate(async () => {
      const api = window.__api;
      api.setViewMode("notes");
      // A highlight to jump TO, placed well down the note so the jump has to
      // scroll and the retry loop actually runs.
      api.state.notes = api.state.notes.replace("P40 alpha", "P40 <mark>alpha</mark>");
      api.setNotesScrolledSource(null);
      await api.renderNotesView();
      await new Promise((r) => setTimeout(r, 600));
      document.querySelector("#notesView").scrollTop = 0;
      window.getSelection()?.removeAllRanges();
      await new Promise((r) => setTimeout(r, 400));
      const marks = document.querySelectorAll("#notesView mark");
      if (!marks.length) return "no <mark> rendered to jump to";
      // Exactly what the Highlights panel's button does.
      api.scheduleNoteJump({ offset: api.state.notes.indexOf("<mark>") }, undefined,
        { markIndex: 0, markCount: marks.length });
      return null;
    });
    if (ok) return ok;
    // Past the jump's own retry loop AND the pill's 160ms debounce.
    await new Promise((r) => setTimeout(r, 1400));
    const state = await page.evaluate(() => ({
      pill: Boolean(document.querySelector("#selectionFloat") && !document.querySelector("#selectionFloat").hidden),
      selected: (window.getSelection()?.toString() || "").trim(),
    }));
    if (state.pill) return "the formatting bar appeared over a selection the reader never made";
    // The span must still be visibly selected — that is what the selection is
    // there for, and suppressing the pill must not cost it.
    if (!state.selected) return "the jump target was not left selected";
    return null;
  });

  // Reported as "the text select options are coming very delayed after selection
  // happening". The bar used to compute everything its BUTTONS need — three
  // clones of the selected fragment, two Turndown conversions, and an occurrence
  // count that clones the whole note above the selection — before drawing
  // itself. None of that is needed to draw it, and on a book it was the entire
  // delay. Measured on a note big enough for the difference to be real.
  await check("the bar appears promptly on a big note", async () => {
    await page.evaluate(async () => {
      const api = window.__api;
      const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet".split(" ");
      const out = ["# Big probe", ""];
      for (let i = 0; i < 3000; i++) out.push("Q" + String(i).padStart(4, "0") + " " + words.join(" ") + ".", "");
      api.state.notes = out.join("\n");
      api.setNotesScrolledSource(null);
      await api.renderNotesView();
      await new Promise((r) => setTimeout(r, 2500));
    });
    const from = await charIn("Q0005", 4);
    const to = await charIn("Q0005", 40);
    if (!from || !to) return "the probe paragraph never came into view";
    await clearSelection();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(from.x + ((to.x - from.x) * i) / 12, from.y + ((to.y - from.y) * i) / 12);
      await new Promise((r) => setTimeout(r, 10));
    }
    const released = Date.now();
    await page.mouse.up();
    // Poll rather than sleep: the number this reports IS the assertion.
    let shownAfter = null;
    while (Date.now() - released < 3000) {
      const shown = await page.evaluate(() => {
        const p = document.querySelector("#selectionFloat");
        return Boolean(p && !p.hidden);
      });
      if (shown) { shownAfter = Date.now() - released; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    if (shownAfter === null) return "the bar never appeared at all";
    // The deliberate settle after release is 45ms; anything much past that is
    // work that should not be on this path.
    if (shownAfter > 400) return `the bar took ${shownAfter}ms to appear after the mouse came up`;
    return null;
  });

} finally {
  await browser.close();
  server.proc.kill();
}

console.log(failures.length ? `\n${failures.length} selection problem(s).` : `\n${ran.count} selection cases, all clean.`);
process.exit(failures.length ? 1 : 0);
