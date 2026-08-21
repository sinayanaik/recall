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
    "/src/notes/inline-highlight-notes.js?v=__BUILD__",
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
    if (shown.length < 9) return `only ${shown.length} rows in the menu`;
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
    if (modes.length < 4) return `only ${modes.length} rows carry a pressed state`;
    for (const mode of modes) {
      if (!mode.switchDrawn) continue;
      const want = mode.pressed === "true" ? "On" : "Off";
      if (mode.switchWord !== want) return `${mode.id} is ${mode.pressed} but reads "${mode.switchWord}"`;
    }
    const wordy = modes.filter((m) => !m.switchDrawn);
    if (modes.length - wordy.length < 3) return `only ${modes.length - wordy.length} modes draw a switch`;
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

  await check("flipping the highlight-notes toggle changes what it says", async () => {
    await openMenu();
    const before = await page.evaluate(READ_MENU);
    const was = before.rows.find((r) => r.id === "inlineNotesBtn");
    if (!was) return "the highlight-notes toggle is not in the menu";
    if (was.switchWord !== "Off") return `it starts at "${was.switchWord}", not Off`;
    await page.evaluate(`() => { document.getElementById("inlineNotesBtn").click(); }`);
    await new Promise((r) => setTimeout(r, 400));
    await openMenu();
    const after = await page.evaluate(READ_MENU);
    const now = after.rows.find((r) => r.id === "inlineNotesBtn");
    if (now.switchWord !== "On") return `after pressing it, it still reads "${now.switchWord}"`;
    if (now.pressed !== "true") return "aria-pressed did not follow the mode";
    // And it says how many notes there are to print, so pressing it and seeing
    // nothing happen is never the only way to find out there are none.
    if (!/\b2\b/.test(now.hint)) return `the row does not say how many notes it prints: "${now.hint}"`;
    return null;
  });

  // ── The two bookmarks ───────────────────────────────────────────────────

  await check("the two bookmark controls are two different sentences", async () => {
    await openMenu();
    const before = await page.evaluate(READ_MENU);
    const set = before.rows.find((r) => r.id === "bookmarkSetBtn");
    const go = before.rows.find((r) => r.id === "bookmarkGoBtn");
    if (!set) return "the set-bookmark control is not in the menu";
    if (!go) return "the go-to-bookmark control is not in the menu";
    if (!go.hidden) return "the go-to-bookmark row is showing before a bookmark exists";
    if (!/bookmark/i.test(set.label)) return `the set row says "${set.label}"`;
    // Their drawings must differ too: they were the same path, filled and not.
    const same = await page.evaluate(`() => {
      const svg = (id) => document.getElementById(id)?.querySelector("svg")?.innerHTML || "";
      return svg("bookmarkSetBtn") === svg("bookmarkGoBtn");
    }`);
    if (same) return "the two bookmark buttons are still the same drawing";
    return null;
  });

  await check("setting a bookmark says the next press will move it", async () => {
    await openMenu();
    await page.evaluate(`() => { document.getElementById("bookmarkSetBtn").click(); }`);
    await new Promise((r) => setTimeout(r, 400));
    await openMenu();
    const after = await page.evaluate(READ_MENU);
    const set = after.rows.find((r) => r.id === "bookmarkSetBtn");
    const go = after.rows.find((r) => r.id === "bookmarkGoBtn");
    if (go.hidden) return "the go-to-bookmark row did not appear once a bookmark existed";
    if (!/move/i.test(set.label)) return `the set row still says "${set.label}" with a bookmark already saved`;
    return null;
  });

  // ── The printed notes ───────────────────────────────────────────────────

  await check("a note printed into a paragraph is drawn differently from it", async () => {
    const seen = await page.evaluate(`() => {
      const notes = [...document.querySelectorAll("#notesView .hl-inline-note")];
      if (!notes.length) return { error: "no printed notes on screen" };
      const host = notes[0].closest("p");
      const paragraph = getComputedStyle(host);
      return {
        count: notes.length,
        forms: notes.map((n) => (n.classList.contains("is-merged") ? "merged" : "block")),
        paragraph: { color: paragraph.color, style: paragraph.fontStyle, size: paragraph.fontSize },
        drawn: notes.map((n) => {
          const css = getComputedStyle(n);
          const before = getComputedStyle(n, "::before");
          return {
            background: css.backgroundColor,
            color: css.color,
            style: css.fontStyle,
            size: css.fontSize,
            marker: before.content === "none" ? "" : before.content,
            // Transparent is the failure being guarded: an 8%-of-accent tint
            // over the page is a difference you have to be told about.
            alpha: Number((css.backgroundColor.match(/[\\d.]+\\)$/) || ["1)"])[0].slice(0, -1))
          };
        })
      };
    }`);
    if (seen.error) return seen.error;
    if (seen.count !== 2) return `${seen.count} printed notes, expected 2`;
    if (!seen.forms.includes("merged") || !seen.forms.includes("block")) {
      return `both notes took the same form: ${seen.forms.join(", ")}`;
    }
    for (let i = 0; i < seen.drawn.length; i += 1) {
      const note = seen.drawn[i];
      if (note.background === "rgba(0, 0, 0, 0)") return `the ${seen.forms[i]} note has no tint at all`;
      if (note.alpha < 0.08) return `the ${seen.forms[i]} note's tint is ${note.alpha}, which is not a difference`;
      if (note.color === seen.paragraph.color && note.style === seen.paragraph.style) {
        return `the ${seen.forms[i]} note is the same colour and style as its paragraph`;
      }
      if (!note.marker) return `the ${seen.forms[i]} note carries no marker saying it is a note`;
    }
    return null;
  });

  // "Distinct" has to mean distinct in every theme, and the tints here are all
  // color-mix of the accent over TRANSPARENT — so what a reader actually sees
  // is that mix composited over whatever the page behind it is. Ten themes, of
  // which three are light, and a tint tuned by eye on the dark one it was built
  // against can land as either invisible or unreadable on a light one. Both are
  // measured: the composited background has to differ from the page, and the
  // note's own text has to stay readable against it.
  await check("a printed note is distinct and readable in a light theme", async () => {
    const seen = await page.evaluate(`() => {
      document.documentElement.dataset.theme = "light-paper";
      // Two serialisations, and they are on DIFFERENT scales. A plain colour
      // comes back as "rgb(244, 242, 236)"; anything that went through
      // color-mix() — which is every tint in this file — comes back as
      // "color(srgb 0.086 0.474 0.423 / 0.15)", with channels in 0..1. Read
      // one as the other and every number below is off by 255x.
      const parse = (value) => {
        const parts = (value.match(/-?[\\d.]+(?:e-?\\d+)?/g) || []).map(Number);
        const scale = value.startsWith("color(") ? 255 : 1;
        return {
          r: (parts[0] || 0) * scale,
          g: (parts[1] || 0) * scale,
          b: (parts[2] || 0) * scale,
          a: parts.length > 3 ? parts[3] : 1
        };
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
      const page = parse(getComputedStyle(document.body).backgroundColor);
      return [...document.querySelectorAll("#notesView .hl-inline-note")].map((node) => {
        const css = getComputedStyle(node);
        const back = over(parse(css.backgroundColor), page);
        return {
          form: node.classList.contains("is-merged") ? "merged" : "block",
          fromPage: Math.round(ratio(back, page) * 100) / 100,
          readable: Math.round(ratio(over(parse(css.color), back), back) * 100) / 100
        };
      });
    }`);
    try {
      if (!seen.length) return "no printed notes on screen";
      for (const note of seen) {
        // 1.0 is "the same colour as the page". Small, but the eye reads a
        // filled shape at a lower threshold than it reads text, and the ring
        // and the ✎ are carrying the rest of it.
        if (note.fromPage < 1.06) return `the ${note.form} note's tint is ${note.fromPage}:1 against the page — invisible`;
        if (note.readable < 4.5) return `the ${note.form} note's own text is ${note.readable}:1 on its tint — unreadable`;
      }
      return null;
    } finally {
      await page.evaluate(`() => { document.documentElement.dataset.theme = "dark-amoled-emerald"; }`);
    }
  });

  await check("nothing printed into a paragraph can be selected out of it", async () => {
    // The printed copies are not the note's text — the source matcher must
    // never see them, or every highlight over an annotated paragraph misses.
    // This is the CSS half of that (the JS half is in selection.js).
    const bad = await page.evaluate(`() => [...document.querySelectorAll("#notesView .hl-inline-note")]
      .filter((n) => getComputedStyle(n).userSelect !== "none").length`);
    if (bad) return `${bad} printed note(s) are selectable`;
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
