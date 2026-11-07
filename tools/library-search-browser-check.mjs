// Does searching the library show FILES — in every view?
//
//   node tools/library-search-browser-check.mjs
//
// The bug this guards: typing in "Search files…" filtered the files and then
// drew the survivors in the active view as if nothing had been typed. Folder
// view — the default — showed one level of a tree built from them, so a file
// two folders down appeared as the folder it was in: search for a file, get a
// folder. Tree view hid matches behind collapsed folders.
//
// tools/library-search-check.mjs covers WHAT matches (pure Node). This covers
// what is drawn: in Folder / Grid / Tree, list and tiles, every match is a file
// row or tile with its matched letters marked; folders whose name matches come
// after; opening one ends the search; Escape clears; Enter opens the best
// match; ticking a folder result selects what the results show inside it.

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

// Files at three depths, two sharing a word, one accented, one at the top.
const LIBRARY = [
  ["Chain Rule", "Math/Calculus"],
  ["Product Rule", "Math/Calculus"],
  ["Limits", "Math/Calculus/Foundations"],
  ["Eigenvalues", "Math/Linear Algebra"],
  ["Rule of chains", "Misc"],
  ["Résumé tips", ""],
  ["Attention Is All You Need", "Reading/Papers"]
];

const SETUP_SRC = `async (library) => {
  const imp = (p) => import(p + "?v=__BUILD__");
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  (await imp("/src/ui/boot-screens.js")).showAuthenticatedUI();
  (await imp("/src/boot.js")).initAppForUser();
  await settle(500);
  const now = Date.now();
  (await imp("/src/library/local-library.js")).writeLocalDeckIndex(library.map(([title, category], i) => ({
    id: "ld_s" + i, title, category, cardCount: 2, hasNotes: true,
    updatedAt: new Date(now - i * 60000).toISOString(), createdAt: new Date(now).toISOString(),
    accessedAt: new Date(now - i * 60000).toISOString(), lastSyncedAt: null, deckId: null, linkIds: ["ld_s" + i]
  })));
  const prefs = await imp("/src/library/my-decks-prefs.js");
  prefs.setMyDecksView("folder"); prefs.setMyDecksDisplay("list"); prefs.setMyDecksCwd("");
  (await imp("/src/ui/deck-header.js")).openMyDecksPanel();
  await settle(600);
  return Boolean(document.getElementById("myDecksSearch"));
}`;

const VIEW_SRC = `async ([view, display]) => {
  const prefs = await import("/src/library/my-decks-prefs.js?v=__BUILD__");
  prefs.setMyDecksView(view); prefs.setMyDecksDisplay(display);
}`;

// What the library is showing, with each file title's marked letters.
const READ_SRC = `() => {
  const body = document.getElementById("myDecksBody");
  const visible = (n) => n.offsetParent !== null;
  const title = (n) => Array.from(n.childNodes).filter((c) => !c.classList?.contains("deck-result-path")).map((c) => c.textContent).join("");
  return {
    files: Array.from(body.querySelectorAll(".my-deck-row td[data-label=Title], .deck-tile .deck-tile-title")).filter(visible).map(title),
    marks: Array.from(body.querySelectorAll("mark.my-decks-match")).filter(visible).map((m) => m.textContent),
    folders: Array.from(body.querySelectorAll(".deck-folder-nav .deck-folder-name, .folder-tile .folder-tile-name")).filter(visible).map((n) => n.textContent),
    empty: body.querySelector(".web-decks-empty, .my-decks-empty-card")?.textContent || "",
    count: document.getElementById("myDecksCount")?.textContent || "",
    query: document.getElementById("myDecksSearch").value,
    view: localStorage.getItem("flashcards_mydecks_view_v1"),
    cwd: localStorage.getItem("flashcards_mydecks_cwd_v1"),
    panelOpen: !document.getElementById("myDecksPanel")?.hidden
  };
}`;

const chrome = findChrome();
if (!chrome) { console.log("library-search-browser-check: no Chrome on this machine — skipping."); process.exit(0); }

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

let failures = 0;
let ran = 0;
function check(name, ok, detail = "") {
  ran += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  ${detail}`}`);
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Typed the way main.js listens: the box's value plus a real input event, then
// past the 160 ms debounce.
async function search(text) {
  await page.evaluate(`(text) => {
    const box = document.getElementById("myDecksSearch");
    box.focus();
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }`, text);
  await settle(350);
  return page.evaluate(READ_SRC);
}
async function key(name) {
  await page.evaluate(`(name) => {
    const box = document.getElementById("myDecksSearch");
    box.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  }`, name);
  await settle(300);
  return page.evaluate(READ_SRC);
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(`${server.base}/index.html`);
  await settle(1200);
  check("the library opens with the seeded files", await page.evaluate(SETUP_SRC, LIBRARY));

  const before = await page.evaluate(READ_SRC);
  check("with nothing typed, Folder view shows folders (the baseline the bug started from)",
    before.folders.includes("Math") && !before.files.includes("Chain Rule"), JSON.stringify(before));

  for (const [view, display] of [["folder", "list"], ["folder", "tiles"], ["grid", "list"], ["grid", "tiles"], ["tree", "list"]]) {
    await page.evaluate(VIEW_SRC, [view, display]);
    const where = `${view}/${display}`;

    const rule = await search("rule");
    check(`${where}: a search shows the matching files, from every folder`,
      ["Chain Rule", "Product Rule", "Rule of chains"].every((t) => rule.files.includes(t)) && rule.files.length === 3,
      JSON.stringify(rule));
    check(`${where}: not the folders they are in`, rule.folders.length === 0, JSON.stringify(rule.folders));
    check(`${where}: the matched letters are marked`, rule.marks.length >= 3 && rule.marks.every((m) => m.toLowerCase() === "rule"), JSON.stringify(rule.marks));
    check(`${where}: the count says how many of how many`, rule.count === "3 of 7 files", rule.count);

    const deep = await search("limits");
    check(`${where}: a file three folders deep is a file`, deep.files.join() === "Limits", JSON.stringify(deep));

    const folder = await search("calculus");
    check(`${where}: a folder's name finds the files inside it, then the folder`,
      ["Chain Rule", "Product Rule", "Limits"].every((t) => folder.files.includes(t)) && folder.folders.join() === "Calculus",
      JSON.stringify(folder));

    const loose = await search("eignvalues");
    check(`${where}: a typo still finds it`, loose.files.join() === "Eigenvalues", JSON.stringify(loose));
    const accent = await search("resume");
    check(`${where}: accents do not matter`, accent.files.join() === "Résumé tips", JSON.stringify(accent));
    const none = await search("zzzz");
    check(`${where}: no match says so`, none.files.length === 0 && /No files or folders match/.test(none.empty), JSON.stringify(none));
  }

  // ── Leaving a search ─────────────────────────────────────────────────────
  await page.evaluate(VIEW_SRC, ["grid", "list"]);
  await search("calculus");
  await page.evaluate(`() => document.querySelector(".deck-folder-nav .deck-folder-label").click()`);
  await settle(300);
  const opened = await page.evaluate(READ_SRC);
  check("opening a folder result ends the search and shows that folder",
    opened.query === "" && opened.view === "folder" && opened.cwd === "Math/Calculus"
      && opened.files.includes("Chain Rule") && opened.folders.join() === "Foundations",
    JSON.stringify(opened));

  await search("rule");
  const cleared = await key("Escape");
  check("Escape clears the search and keeps the library open",
    cleared.query === "" && cleared.panelOpen && cleared.count === "7 files", JSON.stringify(cleared));

  // ── Selection agrees with what is shown ─────────────────────────────────
  await search("calc");
  const ticked = await page.evaluate(`async () => {
    document.querySelector(".deck-folder-nav .my-folder-row-checkbox")?.click();
    const s = await import("/src/library/my-decks-selection.js?v=__BUILD__");
    const n = s.selectedMyDecks().length;
    document.querySelector(".deck-folder-nav .my-folder-row-checkbox")?.click();
    return n;
  }`);
  check("ticking a folder result selects the files the results show in it", ticked === 3, String(ticked));

  // ── Enter ────────────────────────────────────────────────────────────────
  // Typed and Entered faster than the debounce: Enter must act on what is in
  // the box now, not on the results for three letters ago.
  await search("rule");
  const top = await page.evaluate(`async () => {
    const box = document.getElementById("myDecksSearch");
    box.value = "eigen";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const r = await import("/src/library/my-decks-render.js?v=__BUILD__");
    return r.myDecksSearchTop?.deck?.title || null;
  }`);
  await settle(600);
  const after = await page.evaluate(READ_SRC);
  check("Enter opens the best match for what is typed now", top === "Eigenvalues" && !after.panelOpen, `${top} / open=${after.panelOpen}`);
} finally {
  await client.close?.();
  await launched.close();
  server.proc?.kill();
}

console.log(failures
  ? `\nlibrary-search-browser-check: ${failures} failure(s)`
  : "\nlibrary-search-browser-check: a search for a file shows the file");
console.log(`CHECK: ${ran} checks · ${failures} failed`);
process.exit(failures ? 1 : 0);
