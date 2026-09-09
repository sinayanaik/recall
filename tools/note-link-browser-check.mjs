// Can you find a note to link to WITHOUT remembering its name?
//
//   node tools/note-link-browser-check.mjs
//
// The `[[` picker had no check of any kind, and for most of its life it did not
// need a hard one: it filtered titles on a substring and showed eight of them.
// That is also what was wrong with it. Typing "[[" is the moment you reach for a
// note whose name you half-remember, and a strict substring over eight
// alphabetical rows answers "what is it called?" with "you tell me".
//
// So this asks the two questions the browser was built to answer:
//
//   • with nothing typed, can you WALK there? The library's folders are derived
//     from deck categories ("Math/Calculus" is a path), so the tree the picker
//     draws exists nowhere on disk and is rebuilt on every keystroke — which
//     makes "does stepping into a folder show what is in it" a real question
//   • with something typed, does a half-remembered name still land? "chnrl"
//     has to reach "Chain Rule", and used to reach nothing
//   • can the list be SCROLLED, and is it ordered by when you last wrote in a
//     note rather than by the alphabet? A directory of sixty rows in a box that
//     holds six is only a browser if a finger can move it, and a list sorted by
//     name only helps the reader who already knows the name
//
// And one negative, which is the assertion most worth having: none of that may
// change what gets WRITTEN. A picked link is inserted in the id form
// ([[Title|ld_x]]) by insertNoteLinkAtPicker, and that id is the only reason a
// link survives a rename or resolves on a second device. A browser that wrote a
// bare [[Title]] would look identical and quietly break both.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, connect, openPage } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    "/src/notes/link-picker.js?v=__BUILD__",
    "/src/notes/link-browse.js?v=__BUILD__",
    "/src/notes/link-fuzzy.js?v=__BUILD__",
    "/src/notes/note-links.js?v=__BUILD__",
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/library/local-library.js?v=__BUILD__",
    "/src/library/folders.js?v=__BUILD__",
    "/src/storage/deck-store.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/boot-screens.js?v=__BUILD__",
    "/src/cloud/supabase-client.js?v=__BUILD__",
    "/src/cards/new-deck.js?v=__BUILD__",
    "/src/boot.js?v=__BUILD__",
    "/src/core/state.js?v=__BUILD__",
    "/src/core/dom.js?v=__BUILD__"
  ];
  const mods = await Promise.all(paths.map((p) => import(p)));
  const api = {};
  for (const m of mods) for (const k of Object.keys(m)) if (!(k in api)) api[k] = m[k];
  return api;
}`;

// A library with a shape: two folders under Math, one nested pair under
// Reading, and one note filed at the top level of Math itself — so "notes in
// this folder" and "folders under this folder" are both non-empty at once,
// which is where an off-by-one in the tree would show.
// `edited` is days ago: "Product Rule" was written in more recently than "Chain
// Rule" while sorting after it alphabetically, which is the pair that tells the
// two orders apart.
const LIBRARY = [
  { id: "ld_chain", title: "Chain Rule", category: "Math/Calculus", edited: 9 },
  { id: "ld_prod", title: "Product Rule", category: "Math/Calculus", edited: 1 },
  { id: "ld_eigen", title: "Eigenvalues", category: "Math/Linear Algebra", edited: 4 },
  { id: "ld_notation", title: "Notation", category: "Math", edited: 6 },
  { id: "ld_attn", title: "Attention Is All You Need", category: "Reading/Papers", edited: 2 }
];

// A folder with more notes than the popup can show at once, so "can you reach
// the ones below the fold" is a real question rather than a hypothetical.
const BULK = Array.from({ length: 30 }, (_, i) => ({
  id: `ld_bulk${i}`,
  title: `Bulk note ${String(i).padStart(2, "0")}`,
  category: "Bulk",
  edited: 40 + i
}));

const SETUP_SRC = `async (apiSrc, library) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  // Signed out on purpose: loadNoteLinkIndex's cloud half is skipped entirely
  // (and marks itself complete), so the index under test is exactly the local
  // library seeded below and nothing here touches the network.
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  // The shell itself, which boots hidden behind the setup/sign-in screens. The
  // textarea inside it is 0x0 until this runs, and an element with no box
  // cannot take focus — so every dispatched key would go to <body> and the
  // keyboard half of this file would test nothing.
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(500);

  const now = new Date().toISOString();
  api.writeLocalDeckIndex(library.map((deck, order) => ({
    id: deck.id,
    title: deck.title,
    category: deck.category,
    cardCount: 0,
    hasNotes: true,
    updatedAt: new Date(Date.now() - (deck.edited || 0) * 86400000).toISOString(),
    createdAt: now,
    lastSyncedAt: null,
    // Descending, so listLocalDecks' newest-first order is a known one and the
    // Recent section can be asserted rather than guessed at.
    accessedAt: new Date(Date.now() - order * 60000).toISOString(),
    notesConflicted: false,
    notesSyncFailed: false,
    deckId: null,
    linkIds: [deck.id]
  })));
  api.invalidateNoteLinkIndex();

  api.createNewDeck({ title: "Host note", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  // The note doing the linking lives in Math/Calculus, which is where the
  // picker should open.
  api.state.deckCategory = "Math/Calculus";
  api.enterNotesEditing();
  await settle(300);
  const area = document.getElementById("notesEdit");
  return { editing: api.isNotesEditing(), hasArea: Boolean(area) && !area.hidden };
}`;

// What the popup is showing, in the terms the assertions are written in.
const READ_SRC = `() => {
  const host = document.getElementById("noteLinkPicker");
  if (!host || host.hidden) return { open: false, rows: [], crumbs: "" };
  return {
    open: true,
    crumbs: host.querySelector(".note-link-picker-where")?.textContent || "",
    sort: host.querySelector(".note-link-picker-sort")?.dataset.pickerSort || "",
    sortLabel: host.querySelector(".note-link-picker-sort")?.textContent || "",
    scrollable: host.scrollHeight > host.clientHeight + 4,
    scrollTop: host.scrollTop,
    sections: Array.from(host.querySelectorAll(".note-link-picker-section")).map((n) => n.textContent),
    rows: Array.from(host.querySelectorAll(".note-link-picker-row")).map((row) => ({
      title: row.querySelector(".note-link-picker-title")?.textContent || "",
      path: row.querySelector(".note-link-picker-path")?.textContent || "",
      folder: row.classList.contains("is-folder"),
      up: row.classList.contains("is-up"),
      create: row.classList.contains("is-create"),
      active: row.classList.contains("is-active"),
      marks: Array.from(row.querySelectorAll("mark")).map((m) => m.textContent)
    }))
  };
}`;

const chrome = findChrome();
if (!chrome) { console.log("note-link-browser-check: no Chrome on this machine — skipping."); process.exit(0); }

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

let failures = 0;
let ran = 0;
function check(name, ok, detail = "") {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// Text goes in through the textarea's own value plus a real input event, which
// is the signal main.js binds updateNoteLinkPicker to. Input.insertText needs a
// focused frame and silently does nothing in a headless tab without one — and
// what this file is actually asking about is the KEYS, which are dispatched for
// real below and routed to whatever has focus in the page.
async function type(text) {
  await page.evaluate(`(text) => {
    const area = document.getElementById("notesEdit");
    const at = area.selectionStart;
    area.value = area.value.slice(0, at) + text + area.value.slice(area.selectionEnd);
    area.setSelectionRange(at + text.length, at + text.length);
    area.focus();
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }`, text);
  await new Promise((r) => setTimeout(r, 320));
}

async function press(key, code, vk) {
  const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  await new Promise((r) => setTimeout(r, 320));
}

// Alt is modifier bit 1 in CDP. text/key are what the page reads, and the
// picker's handler tests event.altKey — so both halves have to be sent.
async function pressAltS() {
  const common = { key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 1 };
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  await new Promise((r) => setTimeout(r, 320));
}

const ARROW_DOWN = ["ArrowDown", "ArrowDown", 40];
const ARROW_RIGHT = ["ArrowRight", "ArrowRight", 39];
const ARROW_LEFT = ["ArrowLeft", "ArrowLeft", 37];
const ENTER = ["Enter", "Enter", 13];

// Move the highlight onto the row whose title is `title`, by pressing ArrowDown
// the right number of times.
//
// Deliberately not by reaching into the module's noteLinkPickerIndex: every
// piece of picker state is an `export let`, and the api object these probes are
// built from copies each binding ONCE at import. A reassigned `let` read back
// through that copy is the value it had at boot, which is how an earlier
// version of this file "found" row -1 every time. The DOM is the live answer.
async function highlight(title) {
  const at = await page.evaluate(`(title) => {
    const rows = Array.from(document.querySelectorAll("#noteLinkPicker .note-link-picker-row"));
    const want = rows.findIndex((row) => row.querySelector(".note-link-picker-title")?.textContent.includes(title));
    const active = Math.max(0, rows.findIndex((row) => row.classList.contains("is-active")));
    return { want, active, count: rows.length };
  }`, title);
  if (at.want === -1) return false;
  const steps = (at.want - at.active + at.count) % at.count;
  for (let i = 0; i < steps; i += 1) await press(...ARROW_DOWN);
  return await page.evaluate(`(title) => {
    const row = document.querySelector("#noteLinkPicker .note-link-picker-row.is-active .note-link-picker-title");
    return Boolean(row && row.textContent.includes(title));
  }`, title);
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // Without this a headless tab has no focus, so a dispatched key is routed to
  // nothing and every keyboard assertion below passes vacuously — or, worse,
  // reaches document but not the focused textarea, which is exactly half of
  // what the picker's capture-phase handler is for.
  await page.call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.goto(`${server.base}/index.html`);
  await new Promise((r) => setTimeout(r, 1200));
  const ready = await page.evaluate(SETUP_SRC, API_SRC, LIBRARY.concat(BULK));
  if (!ready.editing || !ready.hasArea) throw new Error(`the raw editor did not open: ${JSON.stringify(ready)}`);

  await page.evaluate(`() => { const a = document.getElementById("notesEdit"); a.focus(); a.setSelectionRange(a.value.length, a.value.length); }`);

  // ── Browsing ─────────────────────────────────────────────────────────────
  await type("[[");
  const opened = await page.evaluate(READ_SRC);
  check("[[ opens the picker with nothing typed", opened.open);
  check("...on the folder the note itself lives in",
    opened.crumbs.includes("Math") && opened.crumbs.includes("Calculus"), JSON.stringify(opened.crumbs));
  check("...listing that folder's notes",
    opened.rows.some((r) => r.title === "Chain Rule") && opened.rows.some((r) => r.title === "Product Rule"),
    opened.rows.map((r) => r.title).join(" | "));
  check("...headed by what you had open recently",
    (opened.sections || []).includes("Recent"), JSON.stringify(opened.sections));
  check("...and offers the way back out", opened.rows.some((r) => r.up));

  // ── The order the notes come in ──────────────────────────────────────────
  //
  // Product Rule was edited eight days after Chain Rule and sorts after it by
  // name, so which of the two comes first says which order is in force.
  const folderTitles = (read) => read.rows.filter((r) => !r.up && !r.folder && !r.create).map((r) => r.title);
  check("the folder's notes are newest-first, not alphabetical",
    folderTitles(opened).indexOf("Product Rule") < folderTitles(opened).indexOf("Chain Rule"),
    folderTitles(opened).join(" | "));
  check("...and the breadcrumb says so", opened.sort === "modified" && opened.sortLabel.includes("Recent"),
    JSON.stringify(opened.sortLabel));

  await pressAltS();
  const alpha = await page.evaluate(READ_SRC);
  check("Alt+S switches the same list to A\u2013Z",
    alpha.sort === "title" && folderTitles(alpha).indexOf("Chain Rule") < folderTitles(alpha).indexOf("Product Rule"),
    folderTitles(alpha).join(" | "));
  check("...and remembers the choice for next time",
    await page.evaluate(`() => localStorage.getItem("flashcards_note_link_sort_v1")`) === "title");

  // The chip is the same switch for a pointer.
  await page.evaluate(`() => {
    const chip = document.querySelector("#noteLinkPicker .note-link-picker-sort");
    chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
  }`);
  await new Promise((r) => setTimeout(r, 320));
  const backToRecent = await page.evaluate(READ_SRC);
  check("...as does the chip in the breadcrumb",
    backToRecent.sort === "modified"
      && folderTitles(backToRecent).indexOf("Product Rule") < folderTitles(backToRecent).indexOf("Chain Rule"),
    `${backToRecent.sort}: ${folderTitles(backToRecent).join(" | ")}`);

  // Out of Math/Calculus into Math, which holds both folders AND a note — the
  // shape an off-by-one in the tree would get wrong.
  await press(...ARROW_LEFT);
  const up = await page.evaluate(READ_SRC);
  check("\u2190 backs out one folder",
    up.open && up.crumbs.includes("Math") && !up.crumbs.includes("Calculus"), JSON.stringify(up.crumbs));
  check("...to its subfolders, each saying how much is in it",
    up.rows.some((r) => r.folder && r.title.includes("Calculus") && r.path === "2 notes")
      && up.rows.some((r) => r.folder && r.title.includes("Linear Algebra") && r.path === "1 note"),
    up.rows.filter((r) => r.folder).map((r) => `${r.title} (${r.path})`).join(" | "));
  check("...alongside the notes filed at that level itself",
    up.rows.some((r) => !r.folder && !r.up && r.title === "Notation"),
    up.rows.map((r) => r.title).join(" | "));

  // ...and out again, to every top-level folder in the library.
  await press(...ARROW_LEFT);
  const root = await page.evaluate(READ_SRC);
  check("\u2190 again reaches the root",
    root.open && root.rows.some((r) => r.folder && r.title.includes("Reading")), JSON.stringify(root.crumbs));
  check("...where a folder counts everything nested under it, not just its own",
    root.rows.find((r) => r.folder && r.title.includes("Math"))?.path === "4 notes",
    root.rows.filter((r) => r.folder).map((r) => `${r.title} (${r.path})`).join(" | "));

  // ...and back down into one, by keyboard.
  check("the Reading folder is reachable with the arrows", await highlight("Reading"));
  await press(...ARROW_RIGHT);
  const inside = await page.evaluate(READ_SRC);
  check("\u2192 steps into the highlighted folder",
    inside.open && inside.crumbs.includes("Reading"), JSON.stringify(inside.crumbs));
  check("...and shows what is nested under it",
    inside.rows.some((r) => r.folder && r.title.includes("Papers")),
    inside.rows.map((r) => r.title).join(" | "));

  // ── Searching ────────────────────────────────────────────────────────────
  //
  // Fuzzy, and across the WHOLE library rather than the folder being browsed —
  // the picker is standing in Reading, and the answer is in Math/Calculus.
  await type("chnrl");
  const fuzzy = await page.evaluate(READ_SRC);
  check("a half-remembered name still finds the note",
    fuzzy.rows.some((r) => r.title === "Chain Rule"),
    fuzzy.rows.map((r) => r.title).join(" | "));
  check("...with the matched letters marked",
    (fuzzy.rows.find((r) => r.title === "Chain Rule")?.marks || []).join("").toLowerCase() === "chnrl",
    JSON.stringify(fuzzy.rows.find((r) => r.title === "Chain Rule")?.marks));
  check("...and searching ignores the folder being browsed", !fuzzy.crumbs);
  check("...while the create row is still the last one",
    fuzzy.rows[fuzzy.rows.length - 1]?.create);

  // ── What gets written ────────────────────────────────────────────────────
  check("the fuzzy match can be highlighted", await highlight("Chain Rule"));
  await press(...ENTER);
  const written = await page.evaluate(`() => ({
    value: document.getElementById("notesEdit").value,
    open: !document.getElementById("noteLinkPicker").hidden
  })`);
  check("Enter writes the link in the ID form, not a bare title",
    written.value.includes("[[Chain Rule|ld_chain]]"), JSON.stringify(written.value.slice(-40)));
  check("...and closes the picker", !written.open);

  // ── Committing a browsed row ─────────────────────────────────────────────
  //
  // The same assertion by the other route: reached by walking rather than by
  // typing, a note must still be written with its id — the browser may change
  // how you FIND a note and must not change how the link is recorded.
  await type(" [[");
  check("a browsed note is selectable without typing anything", await highlight("Product Rule"));
  await press(...ENTER);
  const browsedLink = await page.evaluate(`() => document.getElementById("notesEdit").value`);
  check("...and is written with its id too",
    browsedLink.includes("[[Product Rule|ld_prod]]"), JSON.stringify(browsedLink.slice(-40)));

  // ── A list too long for the box ──────────────────────────────────────────
  //
  // Thirty notes in one folder, in a popup that holds six. The rows' own
  // pointerdown used to call preventDefault() for every pointer type, which
  // cancels the gesture a touch device turns into a scroll — so the list below
  // the fold could not be reached with a finger at all.
  await type(" [[");
  await press(...ARROW_LEFT);
  await press(...ARROW_LEFT);
  check("the Bulk folder is reachable", await highlight("Bulk"));
  await press(...ARROW_RIGHT);
  const bulk = await page.evaluate(READ_SRC);
  check("a folder of thirty notes overflows the popup", bulk.scrollable, JSON.stringify(bulk.rows.length));

  const dragged = await page.evaluate(`() => {
    const host = document.getElementById("noteLinkPicker");
    const row = host.querySelectorAll(".note-link-picker-row")[3];
    const box = row.getBoundingClientRect();
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch",
      pointerId: 7, clientX: box.left + 20, clientY: box.top + 8 });
    row.dispatchEvent(down);
    const prevented = down.defaultPrevented;
    // The finger travels: a drag is a scroll, not a choice.
    host.scrollTop = 120;
    row.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "touch",
      pointerId: 7, clientX: box.left + 20, clientY: box.top - 92 }));
    return { prevented, scrolled: host.scrollTop, open: !host.hidden,
      value: document.getElementById("notesEdit").value };
  }`);
  await new Promise((r) => setTimeout(r, 200));
  check("a finger on a row does not cancel the scroll it was starting", !dragged.prevented);
  check("...so the list actually moves", dragged.scrolled > 0, String(dragged.scrolled));
  check("...and a drag chooses nothing", dragged.open && !dragged.value.includes("Bulk note"),
    JSON.stringify(dragged.value.slice(-40)));

  const kept = await page.evaluate(`() => {
    const host = document.getElementById("noteLinkPicker");
    const area = document.getElementById("notesEdit");
    area.dispatchEvent(new Event("input", { bubbles: true }));
    return host.scrollTop;
  }`);
  await new Promise((r) => setTimeout(r, 320));
  const stillThere = await page.evaluate(`() => document.getElementById("noteLinkPicker").scrollTop`);
  check("...and a redraw of the same list keeps your place in it",
    stillThere > 0, `${kept} -> ${stillThere}`);

  // A tap that stays put is still a choice, and still writes the id form.
  const tapped = await page.evaluate(`() => {
    const host = document.getElementById("noteLinkPicker");
    const rows = Array.from(host.querySelectorAll(".note-link-picker-row"));
    const row = rows.find((r) => r.querySelector(".note-link-picker-title")?.textContent.startsWith("Bulk note"));
    const box = row.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 9,
      clientX: box.left + 20, clientY: box.top + 8 };
    row.dispatchEvent(new PointerEvent("pointerdown", at));
    row.dispatchEvent(new PointerEvent("pointerup", at));
    return row.querySelector(".note-link-picker-title").textContent;
  }`);
  await new Promise((r) => setTimeout(r, 320));
  const tapWrote = await page.evaluate(`() => document.getElementById("notesEdit").value`);
  check("a tap that stays put picks the row it landed on",
    tapWrote.includes(`[[${tapped}|ld_bulk`), `${tapped}: ${JSON.stringify(tapWrote.slice(-40))}`);

  // ── Making one that is not there yet, from the browser ───────────────────
  //
  // The create row used to appear only once something had been typed, so the
  // reader who went LOOKING for a note and found it missing had to leave the
  // popup to make it. Browsing ends on the same offer, in its own terms: it has
  // no typed name, so it asks for one, and files it where you were standing.
  await type(" [[");
  const browseRows = await page.evaluate(READ_SRC);
  const lastRow = browseRows.rows[browseRows.rows.length - 1];
  check("browsing ends on a way to create a note", Boolean(lastRow?.create),
    browseRows.rows.map((r) => r.title).join(" | "));
  check("...which says which folder it would go in",
    lastRow?.path.includes("Calculus"), JSON.stringify(lastRow?.path));

  check("the create row can be highlighted", await highlight("New note"));
  await press(...ENTER);
  const asked = await page.evaluate(`() => ({
    open: !document.getElementById("promptModal").hidden,
    hint: document.getElementById("promptModalHint").textContent
  })`);
  check("choosing it asks for a name", asked.open, JSON.stringify(asked));
  check("...saying where the note will be filed", asked.hint.includes("Calculus"), JSON.stringify(asked.hint));

  await page.evaluate(`() => {
    document.getElementById("promptModalInput").value = "Quotient Rule";
    document.getElementById("promptModalOkBtn").click();
  }`);
  await new Promise((r) => setTimeout(r, 500));
  const folderModal = await page.evaluate(`() => {
    const modal = document.querySelector(".category-choice-modal");
    if (!modal) return { open: false, category: "" };
    const category = modal.querySelector("[data-category-select]")?.value || "";
    modal.querySelector("[data-category-save]").click();
    return { open: true, category };
  }`);
  check("...then offers the browsed folder as where it goes",
    folderModal.open && folderModal.category === "Math/Calculus", JSON.stringify(folderModal));
  await new Promise((r) => setTimeout(r, 600));
  const madeIt = await page.evaluate(`() => {
    const made = window.__recall.api.readLocalDeckIndex().find((d) => d.title === "Quotient Rule");
    return { value: document.getElementById("notesEdit").value, category: made?.category || "", id: made?.id || "" };
  }`);
  check("...creates the note there", madeIt.category === "Math/Calculus", JSON.stringify(madeIt.category));
  check("...and links to it by id, like every other row",
    madeIt.id && madeIt.value.includes(`[[Quotient Rule|${madeIt.id}]]`),
    JSON.stringify(madeIt.value.slice(-40)));

  // ── The note you are in ──────────────────────────────────────────────────
  await type(" [[");
  const noSelf = await page.evaluate(READ_SRC);
  check("the note being written is never offered as a destination",
    !noSelf.rows.some((r) => r.title === "Host note"),
    noSelf.rows.map((r) => r.title).join(" | "));

  // Escape still belongs to the picker alone.
  await press("Escape", "Escape", 27);
  const closed = await page.evaluate(`() => ({
    picker: !document.getElementById("noteLinkPicker").hidden,
    editing: window.__recall.api.isNotesEditing()
  })`);
  check("Escape closes the picker and leaves the editor open",
    !closed.picker && closed.editing, JSON.stringify(closed));

} finally {
  await client.close?.();
  // close(), not proc.kill() — see the note in tools/note-editor-check.mjs.
  await launched.close();
  server.proc?.kill();
}

console.log(failures
  ? `\nnote-link-browser-check: ${failures} failure(s)`
  : "\nnote-link-browser-check: you can find a note without remembering its name");
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
