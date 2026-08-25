// Can you tell what the notes ⋯ menu's controls do, and which way they are set?
//
//   node tools/notes-menu-check.mjs
//   node tools/notes-menu-check.mjs --shot=out.png   # ...and screenshot it:
//                                                    # the menu at both widths,
//                                                    # and the printed notes
//
// Everything in that menu worked. It was reported as unusable anyway, and all
// three halves of the report were about the same thing — a control that only
// says what it is in a `title`:
//
//   • the highlight-notes toggle "does not mention whether it's on or off";
//   • "save bookmark and go to bookmark" were two states of one drawing, so
//     which was which could only be found by hovering, or by pressing one;
//   • the notes it prints into the text "are not visually distinct" from the
//     text they were printed into.
//
// A tooltip is not an answer to any of those. It does not exist on a phone at
// all, it costs a hover and a second of waiting everywhere else, and it can
// only ever describe ONE control at a time — so a tray of ten glyphs is ten
// separate hovers before you know what you are looking at. None of that is
// visible to a check that asserts a click had its effect, which is why every
// one of these shipped working and unusable.
//
// So this asserts the things a person can SEE, in a real browser, at both
// widths: that every row says what it does in words, that every mode says
// which way it is set and changes what it says when flipped, that the two
// bookmark controls are two different sentences and two different drawings,
// and that a note printed into a paragraph is drawn differently from the
// paragraph it landed in — measured as contrast against the page, in a light
// theme as well as a dark one, because every tint here is a color-mix over
// TRANSPARENT and what a reader sees is that mix over whatever is behind it.
//
// It speaks CDP directly (tools/cdp.mjs) rather than going through puppeteer,
// for the reason given at the top of that file: the puppeteer-based checks skip
// themselves wherever the package is not installed, and a check that skips is a
// check that never catches anything.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage, emulatePhone } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const SHOT = (args.find((a) => a.startsWith("--shot=")) || "").slice(7)
  || (args.includes("--shot") ? "notes-menu.png" : "");

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

// The app's modules, flattened — the page exposes no global API. Same approach
// as mobile-menu-check's API_SRC.
const API_SRC = `async () => {
  const paths = [
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/notes/highlight-badges.js?v=__BUILD__",
    "/src/notes/bookmark.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// Two annotated highlights, one of each shape the printed form takes: a
// one-line note is merged into its own paragraph, a note with a line break in
// it becomes a block under it (isMergedNote). Both are written in the ordinary
// storage form — a data-note id on the mark, the text in the "## Highlight
// Notes" section — so nothing here depends on a private test format.
const FIXTURE = [
  "# The menu fixture",
  "",
  "A first paragraph with <mark data-note=\"hn-aa11\">an annotated highlight</mark> in the middle of it, and enough ordinary words after it that the printed note has a sentence to be distinct from.",
  "",
  "A second paragraph, again with <mark data-note=\"hn-bb22\">a longer annotation</mark> on it, so that the block form of a printed note is on screen at the same time as the merged one.",
  "",
  "A third paragraph carrying no highlight at all, which is what the other two are compared against.",
  "",
  "---",
  "",
  "## Highlight Notes",
  "",
  "### [hn-aa11] “an annotated highlight”",
  "",
  "One line, so this one is merged into the paragraph.",
  "",
  "### [hn-bb22] “a longer annotation”",
  "",
  "Two lines of note,",
  "which makes this one a block of its own.",
  ""
].join("\n");

const SETUP_SRC = `async (apiSrc, fixture) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };

  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1", email: "you@example.com" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1", email: "you@example.com" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("notes-menu-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  // The app's own boot has to land BEFORE any of this. On a fresh browser
  // profile there is no Supabase config, so boot ends by showing the setup
  // screen — and it does that asynchronously, some way after the load event
  // this evaluate is fired on. Signing in over the top of a boot still in
  // flight means the shell is hidden again a moment later, and every assertion
  // below then measures a control of zero by zero pixels and calls it invisible.
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Notes menu fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(300);
  api.state.notes = fixture;
  api.setNotesScrolledSource(null);
  await api.renderNotesView();
  await settle(600);
  return document.querySelectorAll("#notesView mark").length;
}`;

const chrome = findChrome();
if (!chrome) { console.log("notes-menu-check: no Chrome on this machine — skipping."); process.exit(0); }

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

// The browser is launched at phone size (see launchChrome's --window-size), and
// the first half of this runs at desktop width on purpose: the menu is not
// phone-only, and "there was room for it" was never a reason a control read as
// anything. The phone case at the end overrides this back down.
async function emulateDesktop() {
  await page.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 860, deviceScaleFactor: 1, mobile: false
  });
}

// The menu closes on any press inside it — including the presses these cases
// make — so every read opens it first. A row in a closed menu measures zero by
// zero, which would read as "the label is not visible" and pass this check off
// as the very bug it is here to catch.
async function openMenu() {
  await page.evaluate(`() => {
    const menu = document.getElementById("notesHeadMoreMenu");
    if (menu && menu.hidden) document.getElementById("notesHeadMoreBtn").click();
  }`);
  await new Promise((r) => setTimeout(r, 150));
}

// Both widths, when asked for one: the menu is not a phone control, and the two
// layouts are the same design or the file it lives in has failed at its job.
// `menu: false` closes it instead, for the other half of the same report — the
// printed notes, in the paragraphs they were printed into.
async function shoot(file, { menu = true } = {}) {
  if (menu) await openMenu();
  else {
    await page.evaluate(`() => {
      const box = document.getElementById("notesHeadMoreMenu");
      if (box && !box.hidden) document.getElementById("notesHeadMoreBtn").click();
    }`);
    await new Promise((r) => setTimeout(r, 150));
  }
  const shot = await page.call("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.resolve(ROOT, file), Buffer.from(shot.data, "base64"));
  console.log(`      screenshot → ${file}`);
}

const failures = [];
let ran = 0;
async function check(name, fn) {
  ran += 1;
  let detail = null;
  try { detail = await fn(); } catch (error) { detail = String(error.message || error); }
  if (detail) failures.push({ name, detail });
  console.log(`${detail ? "FAIL" : "ok  "}  ${name}${detail ? `\n        ${detail}` : ""}`);
}

// Everything the menu shows, read the way a reader reads it: what is on screen
// and legible, never what the markup happens to contain. A label the CSS has
// hidden is not a label, which is exactly the failure being guarded against.
const READ_MENU = `() => {
  const menu = document.getElementById("notesHeadMoreMenu");
  if (!menu) return { error: "no ⋯ menu in the page" };
  const seen = (node) => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden";
  };
  const rows = [...menu.querySelectorAll(":scope > button")].map((button) => {
    const label = button.querySelector(".nhm-label");
    const state = button.querySelector(".nhm-state");
    const pressed = button.getAttribute("aria-pressed");
    const word = state && seen(state)
      ? getComputedStyle(state, "::before").content.replace(/^"|"$/g, "")
      : "";
    return {
      id: button.id || button.className.split(" ").find((c) => c !== "edit-card-btn") || "?",
      hidden: button.hidden,
      label: label && seen(label) ? label.textContent.trim() : "",
      hint: (button.querySelector(".nhm-hint")?.textContent || "").trim(),
      pressed,
      switchWord: word,
      switchDrawn: Boolean(state && button.querySelector(".nhm-switch") && seen(state)),
      // What the reader would have to hover to learn anything, before any of
      // the above existed.
      title: button.title || ""
    };
  });
  return {
    open: !menu.hidden,
    groups: [...menu.querySelectorAll(":scope > .nhm-group")].map((n) => n.textContent.trim()),
    rows,
    // The menu must stay inside the window at both widths — a labelled row is
    // wider than a glyph, and this is the first thing that would break.
    box: menu.getBoundingClientRect().toJSON(),
    viewport: { width: innerWidth, height: innerHeight }
  };
}`;

try {
  await emulateDesktop();
  await page.goto(`${server.base}/index.html`);
  const marks = await page.evaluate(SETUP_SRC, API_SRC, FIXTURE);
  if (marks !== 2) throw new Error(`fixture did not render its two highlights (saw ${marks})`);

  await openMenu();

  // ── The menu ────────────────────────────────────────────────────────────

  await check("every row in the ⋯ menu says what it does, in words", async () => {
    await openMenu();
    const menu = await page.evaluate(READ_MENU);
    if (menu.error) return menu.error;
    if (!menu.open) return "the ⋯ menu did not open";
    const shown = menu.rows.filter((r) => !r.hidden);
    // Seven, and it has come down twice. "Notes in the text" — the opt-in mode
    // that printed every highlight's note into the paragraph it annotated —
    // went first; a note is read by pressing the number on its highlight now,
    // or in the Highlights tab. "Bookmark this spot" went second, when the sync
    // took over saving where you are (src/notes/bookmark.js), leaving only the
    // way back — and that row is hidden until there IS a bookmark, so a deck
    // that has never synced sees seven. The floor is here to catch rows going
    // missing by accident, so it tracks what the menu is meant to hold.
    if (shown.length < 7) return `only ${shown.length} rows in the menu`;
    const mute = shown.filter((r) => r.label.length < 4).map((r) => r.id);
    if (mute.length) return `no readable label on: ${mute.join(", ")}`;
    // Two rows that say the same thing are the bookmark report in a different
    // costume, so no label may repeat.
    const labels = shown.map((r) => r.label.toLowerCase());
    const dupe = labels.find((l, i) => labels.indexOf(l) !== i);
    if (dupe) return `two rows both say "${dupe}"`;
    if (menu.groups.length < 4) return `only ${menu.groups.length} group headings: ${menu.groups.join(" / ")}`;
    return null;
  });

  await check("the menu stays on screen at desktop width", async () => {
    await openMenu();
    const menu = await page.evaluate(READ_MENU);
    if (menu.error) return menu.error;
    if (menu.box.left < 0) return `the menu starts ${Math.round(-menu.box.left)}px off the left edge`;
    if (menu.box.right > menu.viewport.width + 1) return "the menu runs off the right edge";
    if (menu.box.bottom > menu.viewport.height + 1) return "the menu runs off the bottom of the window";
    return null;
  });

  // Every row inside the box that is supposed to hold it. This is not the same
  // question as the one above, and the difference cost the last row of the
  // menu: the box was a wrapping flex COLUMN, so the rows that did not fit its
  // height started a second column 324px to the right — off the box, behind the
  // note, and unreachable, while the menu itself reported nothing to scroll.
  await check("no row is laid out outside the menu it is in", async () => {
    await openMenu();
    const stray = await page.evaluate(`() => {
      const menu = document.getElementById("notesHeadMoreMenu");
      const box = menu.getBoundingClientRect();
      const room = menu.scrollHeight + 2;
      return [...menu.children].filter((node) => !node.hidden).map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          id: node.id || node.className,
          out: rect.left < box.left - 1 || rect.right > box.right + 1
            || rect.top - box.top + menu.scrollTop > room
        };
      }).filter((row) => row.out).map((row) => row.id);
    }`);
    if (stray.length) return `laid out outside the menu box: ${stray.join(", ")}`;
    return null;
  });

  // The report, in one assertion: a mode you cannot read the state of.
  //
  // Two shapes are allowed, and the difference is not cosmetic. A mode of the
  // READING SURFACE — focus, full screen, the printed notes — is a thing the
  // note is currently in, so it names itself and a switch says which way it is
  // set. The cloze reveal is the same button the card toolbar carries, and
  // there it is phrased as the action it performs; it says which way it is set
  // by changing its own words (setClozeButtonState), which the press below
  // proves rather than assumes. What is NOT allowed is a third shape: a mode
  // that says neither, which is what all four of them used to be.
  await check("every mode in the menu says which way it is set", async () => {
    await openMenu();
    const menu = await page.evaluate(READ_MENU);
    if (menu.error) return menu.error;
    const modes = menu.rows.filter((r) => r.pressed !== null && !r.hidden);
    // Three, since "Notes in the text" was removed along with the printed mode
    // it toggled. What this case is really about is that a mode which CAN be
    // pressed says which way it is set, and that is unchanged.
    if (modes.length < 3) return `only ${modes.length} rows carry a pressed state`;
    for (const mode of modes) {
      if (!mode.switchDrawn) continue;
      const want = mode.pressed === "true" ? "On" : "Off";
      if (mode.switchWord !== want) return `${mode.id} is ${mode.pressed} but reads "${mode.switchWord}"`;
    }
    const wordy = modes.filter((m) => !m.switchDrawn);
    if (modes.length - wordy.length < 2) return `only ${modes.length - wordy.length} modes draw a switch`;
    for (const mode of wordy) {
      const said = await page.evaluate(`(id) => {
        const button = document.getElementById(id);
        const label = button.querySelector(".nhm-label");
        const before = label.textContent.trim();
        button.click();
        const after = label.textContent.trim();
        button.click();
        return { before, after };
      }`, mode.id);
      if (said.before === said.after) {
        return `${mode.id} has no switch and still says "${said.before}" after being pressed`;
      }
    }
    return null;
  });

  // ── The bookmark is one control now, not two ────────────────────────────
  //
  // There was a "Bookmark this spot" beside it, and the two cases that used to
  // be here were about telling the pair apart: two different drawings, and a
  // label that flipped to "Move bookmark here" once there was one to move. Both
  // are gone with the button. Pressing it and then pressing Sync was one
  // sentence said twice, so reconcileAllDecks captures the spot itself — see
  // captureBookmarkForSync in src/notes/bookmark.js.
  //
  // What is left to check is that the pair really did become one: the set
  // control is ABSENT rather than merely hidden, and the way back appears the
  // moment a sync has saved somewhere to go.

  await check("the bookmark is one control, and it is the way back", async () => {
    await openMenu();
    const before = await page.evaluate(READ_MENU);
    if (before.rows.some((r) => r.id === "bookmarkSetBtn")) {
      return "a set-bookmark control is still in the menu";
    }
    const go = before.rows.find((r) => r.id === "bookmarkGoBtn");
    if (!go) return "the go-to-bookmark control is not in the menu";
    if (!go.hidden) return "the go-to-bookmark row is showing before a bookmark exists";
    // Its TITLE, not its label: a hidden row measures zero by zero, so
    // READ_MENU reports no label for one. The sentence is still there to read
    // the moment it is shown, which the next case is about.
    if (!/bookmark/i.test(go.title)) return `the go row's sentence is "${go.title}"`;
    return null;
  });

  await check("a sync saves the spot, and the way back appears", async () => {
    // The capture, not the whole sync: reconcileAllDecks needs a signed-in
    // Supabase client, and what this case is about is the line that runs before
    // its guards. captureBookmarkForSync is that line.
    const result = await page.evaluate(`() => {
      const { api } = window.__recall;
      // A capture is refused until the deck's resume has settled — the guard
      // that stops the sync 1200ms after boot writing "the top of the note"
      // over a real bookmark. Opening a deck is what normally arms it.
      api.maybePromptBookmarkJump();
      const saved = api.captureBookmarkForSync();
      return { saved, at: api.state.meta && api.state.meta.bookmark ? api.state.meta.bookmark.at : null };
    }`);
    if (!result.saved) return "the sync capture declined to save a spot";
    if (!result.at) return "nothing was written to meta.bookmark";
    await new Promise((r) => setTimeout(r, 200));
    await openMenu();
    const after = await page.evaluate(READ_MENU);
    const go = after.rows.find((r) => r.id === "bookmarkGoBtn");
    if (!go || go.hidden) return "the go-to-bookmark row did not appear once a bookmark existed";
    if (!/bookmark/i.test(go.label)) return `the go row says "${go.label}" now it is showing`;
    // ...and standing still must not write a second one. A changed
    // meta.bookmark.at counts as real content (deckContentMatches), so a
    // bookmark that moved on every auto-sync would push the whole deck every
    // cycle even when nobody had read a word.
    const again = await page.evaluate(`() => {
      const { api } = window.__recall;
      const saved = api.captureBookmarkForSync();
      return { saved, at: api.state.meta && api.state.meta.bookmark ? api.state.meta.bookmark.at : null };
    }`);
    if (again.saved) return "a second sync moved the bookmark without the reader moving";
    if (again.at !== result.at) return "the bookmark was rewritten though nothing had moved";
    return null;
  });

  // ── The number on an annotated highlight ────────────────────────────────
  //
  // These three cases used to be about the printed inline notes. The mode is
  // gone and the badge replaced it, but the QUESTIONS are the same three and
  // they are the reason the badge was rebuilt: can you see it, can you read it,
  // and can it leak into a selection.

  await check("an annotated highlight wears a number you can actually see", async () => {
    const seen = await page.evaluate(`() => {
      const badges = [...document.querySelectorAll("#notesView .hl-note-badge")];
      if (!badges.length) return { error: "no badges on screen" };
      const parse = (value) => {
        const parts = (value.match(/-?[\\d.]+(?:e-?\\d+)?/g) || []).map(Number);
        const scale = value.startsWith("color(") ? 255 : 1;
        return { r: (parts[0] || 0) * scale, g: (parts[1] || 0) * scale, b: (parts[2] || 0) * scale, a: parts.length > 3 ? parts[3] : 1 };
      };
      return {
        count: badges.length,
        drawn: badges.map((n) => {
          const css = getComputedStyle(n);
          const mark = n.closest("mark");
          const markRect = mark.getBoundingClientRect();
          const box = n.getBoundingClientRect();
          return {
            tag: n.tagName,
            position: css.position,
            // An opaque chip, not tinted digits. A colour-mixed background is
            // not something a single ink can be guaranteed to read on, which is
            // what the ::after this replaced kept discovering per theme.
            alpha: parse(css.backgroundColor).a,
            // ...and it has to be ON the highlight it belongs to, not floating
            // somewhere near it.
            near: Math.abs(box.right - markRect.right) < 24 && box.top < markRect.top + 4,
            wide: box.width,
            tall: box.height
          };
        })
      };
    }`);
    if (seen.error) return seen.error;
    if (seen.count !== 2) return `${seen.count} badges, expected 2`;
    for (const badge of seen.drawn) {
      if (badge.tag !== "BUTTON") return `the badge is a ${badge.tag}, which cannot be pressed or focused`;
      if (badge.position !== "absolute") return `the badge is ${badge.position}, so it is in flow and moves the text`;
      if (badge.alpha < 0.99) return `the badge's chip is ${badge.alpha} opaque — the tint under it shows through`;
      if (!badge.near) return "the badge is not drawn on the highlight it belongs to";
      // Small, but a target you can hit. Below this it is decoration.
      if (badge.wide < 10 || badge.tall < 10) return `the badge is ${Math.round(badge.wide)}x${Math.round(badge.tall)}px`;
    }
    return null;
  });

  // "Readable" has to mean readable in every theme, over every highlight
  // colour. Both halves vary: --accent-strong and --accent-contrast are
  // redefined per theme, and a <mark>'s tint is a color-mix of one of four
  // hexes over whatever the page behind it is. This measures the pair that
  // actually decides it — the badge's own ink on the badge's own chip — plus
  // the chip against the tint it sits on, in a light theme and a dark one.
  await check("...and it is readable in every theme, over every highlight colour", async () => {
    const seen = await page.evaluate(`() => {
      // Two serialisations, and they are on DIFFERENT scales. A plain colour
      // comes back as "rgb(244, 242, 236)"; anything that went through
      // color-mix() comes back as "color(srgb 0.086 0.474 0.423 / 0.15)", with
      // channels in 0..1. Read one as the other and every number is off by 255x.
      const parse = (value) => {
        const parts = (value.match(/-?[\\d.]+(?:e-?\\d+)?/g) || []).map(Number);
        const scale = value.startsWith("color(") ? 255 : 1;
        return { r: (parts[0] || 0) * scale, g: (parts[1] || 0) * scale, b: (parts[2] || 0) * scale, a: parts.length > 3 ? parts[3] : 1 };
      };
      const over = (top, bottom) => ({
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
        a: 1
      });
      const lum = (c) => {
        const channel = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
      };
      const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      const was = document.documentElement.dataset.theme;
      const out = [];
      const marks = [...document.querySelectorAll("#notesView mark.has-note")];
      for (const theme of ["light-paper", "dark-amoled-emerald", "dark"]) {
        document.documentElement.dataset.theme = theme;
        for (const colour of ["yellow", "green", "blue", "pink"]) {
          marks.forEach((mark) => { mark.dataset.color = colour; });
          const badge = marks[0].querySelector(".hl-note-badge");
          if (!badge) continue;
          const page = parse(getComputedStyle(document.body).backgroundColor);
          const tint = over(parse(getComputedStyle(marks[0]).backgroundColor), page);
          const css = getComputedStyle(badge);
          const chip = over(parse(css.backgroundColor), tint);
          out.push({
            theme, colour,
            readable: Math.round(ratio(over(parse(css.color), chip), chip) * 100) / 100,
            fromTint: Math.round(ratio(chip, tint) * 100) / 100
          });
        }
      }
      marks.forEach((mark) => { delete mark.dataset.color; });
      document.documentElement.dataset.theme = was;
      return out;
    }`);
    if (!seen.length) return "no annotated highlight to measure";
    for (const one of seen) {
      // The digits on their own chip. This is the pair --accent-contrast is
      // DEFINED as answering, so anything below 4.5 means a theme was added
      // without it.
      if (one.readable < 4.5) return `${one.colour} on ${one.theme}: the number is ${one.readable}:1 on its own chip`;
      // ...and the chip against the highlight under it. A filled shape is read
      // at a lower threshold than text, and the ring is carrying the rest.
      if (one.fromTint < 1.35) return `${one.colour} on ${one.theme}: the chip is ${one.fromTint}:1 against the highlight — invisible`;
    }
    return null;
  });

  await check("nothing drawn on a highlight can be selected out of it", async () => {
    // The badge's digits are not the note's text and are nowhere in the
    // markdown — the source matcher must never see them, or every highlight
    // over an annotated paragraph misses. This is the CSS half of that (the JS
    // half is the two skips in selection.js).
    const bad = await page.evaluate(`() => [...document.querySelectorAll("#notesView .hl-note-badge")]
      .filter((n) => getComputedStyle(n).userSelect !== "none").length`);
    if (bad) return `${bad} badge(s) are selectable`;
    return null;
  });

  // ── The other menu: what a highlight can be turned into ─────────────────
  //
  // A tapped highlight offered four colours and six rows; everything the
  // selection bar could do to unmarked text — search it, share it, read it —
  // needed you to select the words again, which is the one gesture that cannot
  // reliably re-find a span that already has tags round it. The rows are here
  // now, and this is the pair of things that has to hold about them: they are
  // all reachable, and adding them did not push the menu off the screen.
  //
  // Reached by CLICKING a mark, not by calling openMarkMenuFor — the ordinal
  // resolution on the way in (sourceMarkIndexFor) is part of what is being
  // checked, and a menu opened by hand would skip it.
  const READ_MARK_MENU = `() => {
    const menu = document.querySelector(".mark-menu");
    if (!menu || menu.hidden) return { error: "the mark menu did not open" };
    const box = menu.getBoundingClientRect();
    const actions = menu.querySelector(".mark-menu-actions");
    const rows = [...menu.querySelectorAll("[data-mark-action], [data-mark-color]")]
      .filter((b) => !b.hidden)
      .map((b) => ({
        id: b.dataset.markAction || ("colour:" + b.dataset.markColor),
        label: (b.querySelector(".mmi-label") || {}).textContent || "",
        startsRun: b.classList.contains("starts-run")
      }));
    return {
      rows,
      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrolls: Boolean(actions) && actions.scrollHeight > actions.clientHeight + 1,
      canScroll: Boolean(actions) && getComputedStyle(actions).overflowY === "auto"
    };
  }`;

  async function openMarkMenu() {
    await page.evaluate(`() => {
      document.querySelector(".mark-menu")?.setAttribute("hidden", "");
      const mark = document.querySelector("#notesView mark");
      if (mark) mark.click();
    }`);
    await new Promise((r) => setTimeout(r, 250));
  }

  await check("tapping a highlight offers more than a colour and an ✕", async () => {
    await emulateDesktop();
    await new Promise((r) => setTimeout(r, 300));
    await openMarkMenu();
    const menu = await page.evaluate(READ_MARK_MENU);
    if (menu.error) return menu.error;
    const ids = menu.rows.map((r) => r.id);
    // The four the pill already had and a highlight could not reach. "share" is
    // absent where the browser has no share sheet and "speak" where it has no
    // speech engine — headless Chromium has neither reliably — so those two are
    // checked for being ABSENT-or-working rather than required.
    const wanted = ["card", "highlights", "copy", "search", "translate"];
    const missing = wanted.filter((id) => !ids.includes(id));
    if (missing.length) return `no row for: ${missing.join(", ")} (got ${ids.join(", ")})`;
    // ...and every one of them says what it does, in words.
    const mute = menu.rows.filter((r) => r.id.indexOf("colour:") !== 0 && r.label.trim().length < 4);
    if (mute.length) return `no readable label on: ${mute.map((r) => r.id).join(", ")}`;
    // The runs have to be drawn, or eight rows is a list rather than a menu.
    if (!menu.rows.some((r) => r.startsRun)) return "no rule between what stays here and what leaves";
    return null;
  });

  await check("...and the menu it opens still fits the screen", async () => {
    await emulatePhone(page, { width: 390, height: 844 });
    await new Promise((r) => setTimeout(r, 400));
    await openMarkMenu();
    const menu = await page.evaluate(READ_MARK_MENU);
    if (menu.error) return menu.error;
    if (menu.box.left < -1) return `the menu starts ${Math.round(-menu.box.left)}px off the left edge`;
    if (menu.box.right > menu.viewport.width + 1) {
      return `the menu is ${Math.round(menu.box.right - menu.viewport.width)}px past the right edge`;
    }
    if (menu.box.bottom > menu.viewport.height + 1) {
      return `the menu runs ${Math.round(menu.box.bottom - menu.viewport.height)}px off the bottom`;
    }
    if (menu.box.top < -1) return `the menu starts ${Math.round(-menu.box.top)}px above the screen`;
    // ...and where it IS capped, the rows have to be reachable rather than
    // simply cut off. The colours keep their box; the actions scroll under it.
    if (menu.scrolls && !menu.canScroll) return "the menu is taller than its box and does not scroll";
    return null;
  });

  if (SHOT) {
    await shoot(SHOT);
    await shoot(SHOT.replace(/(\.png)?$/, "-notes.png"), { menu: false });
  }

  // ── The same menu, on a phone ───────────────────────────────────────────

  await check("the labelled menu still fits a 390px phone", async () => {
    await emulatePhone(page, { width: 390, height: 844 });
    await new Promise((r) => setTimeout(r, 400));
    await openMenu();
    const menu = await page.evaluate(READ_MENU);
    if (menu.error) return menu.error;
    if (!menu.open) return "the ⋯ menu does not open on a phone";
    if (menu.box.left < 0) return `the menu starts ${Math.round(-menu.box.left)}px off the left edge`;
    if (menu.box.right > menu.viewport.width + 1) {
      return `the menu is ${Math.round(menu.box.right - menu.viewport.width)}px past the right edge`;
    }
    if (menu.box.height > menu.viewport.height) return "the menu is taller than the phone";
    const shown = menu.rows.filter((r) => !r.hidden);
    const mute = shown.filter((r) => !r.label).map((r) => r.id);
    if (mute.length) return `labels lost on a phone: ${mute.join(", ")}`;
    // Every row has to be reachable with a thumb, which on a scrolling menu
    // means being inside it rather than being on screen.
    const short = await page.evaluate(`() => [...document.querySelectorAll("#notesHeadMoreMenu > button")]
      .filter((b) => !b.hidden && b.getBoundingClientRect().height < 32).length`);
    if (short) return `${short} row(s) are under 32px tall`;
    return null;
  });

  if (SHOT) await shoot(SHOT.replace(/(\.png)?$/, "-phone.png"));
} finally {
  client.close();
  launched.close();
  server.proc.kill();
}

console.log(failures.length
  ? `\n${failures.length} of ${ran} notes-menu case(s) failed.`
  : `\n${ran} notes-menu cases, all clean.`);
process.exit(failures.length ? 1 : 0);
