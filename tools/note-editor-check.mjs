// Can you format a highlight's note with the keyboard, and does Ctrl+E stop
// flipping the view behind the popup?
//
// Nothing in this repo drove `.highlight-note-editor` at all before this file —
// the popup is where a note about a highlight is actually written, and it had no
// check of any kind. What that cost is the report this answers: "Ctrl+E and all
// other text formatting features in raw/rendered mode are not applicable to the
// highlighted note popup."
//
// Ctrl+E was worse than not working. The global handler in src/main.js catches
// it wherever it lands, deliberately, so it still fires from inside the notes
// and card textareas — and pressed inside this popup it flipped the NOTES view
// behind it while the reader typed. So the assertion that matters most below is
// a negative one: state.viewMode and isNotesEditing() must be exactly what they
// were before the key was pressed.
//
// The same battery runs against the Highlights tab's in-place editor, because
// that is the other place a note is written and the two must not disagree about
// what a key does.
//
//   node tools/note-editor-check.mjs

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
    "/src/notes/notes-view.js?v=__BUILD__",
    "/src/notes/highlight-note-editor.js?v=__BUILD__",
    "/src/panels/highlights-editor.js?v=__BUILD__",
    "/src/panels/highlights-panel.js?v=__BUILD__",
    "/src/format/highlight-notes.js?v=__BUILD__",
    "/src/ui/view-mode.js?v=__BUILD__",
    "/src/ui/chrome.js?v=__BUILD__",
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

// One annotated highlight and one bare one, in the ordinary storage form.
const FIXTURE = [
  "# A chapter",
  "",
  'A paragraph with <mark data-note="hn-aaaa">an annotated span</mark> in it.',
  "",
  "Another with <mark>a plain highlight</mark> in it.",
  "",
  "<!--recall:highlight-notes-->",
  "",
  '<!--hn:hn-aaaa “an annotated span”-->',
  "",
  "What I wrote about it.",
  "<!--/recall:highlight-notes-->"
].join("\n");

const SETUP_SRC = `async (apiSrc, fixture) => {
  const api = await (0, eval)(apiSrc)();
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__recall = { api, settle };
  api.setSupabaseClient({
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" }, access_token: "t" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null })
    },
    from: () => { throw new Error("note-editor-check does not touch the network"); },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }) }) }
  });
  for (let i = 0; i < 80 && document.getElementById("setupOverlay")?.hidden !== false; i += 1) await settle(50);
  api.setSignedIn(true);
  api.showAuthenticatedUI();
  api.initAppForUser();
  await settle(600);
  api.createNewDeck({ title: "Note editor fixture", notesMode: true });
  await settle(400);
  api.setViewMode("notes");
  await settle(300);
  api.commitNotesEditIfActive();
  await settle(300);
  api.state.notes = fixture;
  api.setNotesScrolledSource(null);
  await api.renderNotesView();
  await settle(500);
  return document.querySelectorAll("#notesView mark").length;
}`;

const chrome = findChrome();
if (!chrome) { console.log("note-editor-check: no Chrome on this machine — skipping."); process.exit(0); }

const server = await serveOn(ROOT);
const launched = await launchChrome(chrome);
const client = await connect(launched.wsUrl);
const page = await openPage(client);

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// A real key, through the input pipeline, because the whole question is which
// listener sees it and in what order. Dispatching a synthetic KeyboardEvent
// would answer a different question.
async function press(key, { ctrl = true, shift = false } = {}) {
  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0);
  const common = { modifiers, key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) };
  await page.call("Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  await new Promise((r) => setTimeout(r, 180));
}

try {
  await page.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(`${server.base}/index.html`);
  await new Promise((r) => setTimeout(r, 1200));
  const marks = await page.evaluate(SETUP_SRC, API_SRC, FIXTURE);
  if (!marks) throw new Error("the fixture rendered no highlights");

  // ── The popup ────────────────────────────────────────────────────────────
  const opened = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    const mark = document.querySelector("#notesView mark[data-note]");
    api.openHighlightNoteEditor(0, mark.getBoundingClientRect(), api.highlightNoteTextAt(0));
    await settle(300);
    const root = document.querySelector(".highlight-note-editor");
    const area = root.querySelector("[data-note-edit-value]");
    // An existing note opens rendered; Write is where the textarea is.
    root.querySelectorAll(".highlight-note-editor-mode")[0].click();
    await settle(200);
    area.focus();
    area.setSelectionRange(0, "What I wrote".length);
    return {
      open: !root.hidden,
      value: area.value,
      viewMode: api.state.viewMode,
      editing: api.isNotesEditing(),
      writeActive: root.querySelectorAll(".highlight-note-editor-mode")[0].classList.contains("is-active")
    };
  }`);
  check("the note popup opens on the highlight's own note",
    opened.open && opened.value === "What I wrote about it.", JSON.stringify(opened.value));
  check("...in Write mode, with a textarea to type in", opened.writeActive);

  await press("b");
  const bolded = await page.evaluate(`() => {
    const { api } = window.__recall;
    const area = document.querySelector(".highlight-note-editor [data-note-edit-value]");
    return { value: area.value, viewMode: api.state.viewMode, editing: api.isNotesEditing() };
  }`);
  check("Ctrl+B bolds the selection in the popup",
    bolded.value === "**What I wrote** about it.", JSON.stringify(bolded.value));

  await press("i");
  const italic = await page.evaluate(`() => document.querySelector(".highlight-note-editor [data-note-edit-value]").value`);
  check("...and Ctrl+I italicises what it left selected",
    italic === "***What I wrote*** about it.", JSON.stringify(italic));

  await press("z");
  const undone = await page.evaluate(`() => document.querySelector(".highlight-note-editor [data-note-edit-value]").value`);
  check("...and Ctrl+Z steps back over it, which native undo cannot",
    undone === "**What I wrote** about it.", JSON.stringify(undone));

  await press("z", { shift: true });
  const redone = await page.evaluate(`() => document.querySelector(".highlight-note-editor [data-note-edit-value]").value`);
  check("...and Ctrl+Shift+Z puts it back",
    redone === "***What I wrote*** about it.", JSON.stringify(redone));

  // The one that was actually broken.
  const before = await page.evaluate(`() => {
    const { api } = window.__recall;
    return { viewMode: api.state.viewMode, editing: api.isNotesEditing() };
  }`);
  await press("e");
  const flipped = await page.evaluate(`() => {
    const { api } = window.__recall;
    const root = document.querySelector(".highlight-note-editor");
    const modes = root.querySelectorAll(".highlight-note-editor-mode");
    return {
      viewMode: api.state.viewMode,
      editing: api.isNotesEditing(),
      previewActive: modes[1].classList.contains("is-active"),
      renderedShown: !root.querySelector(".highlight-note-editor-rendered").hidden
    };
  }`);
  check("Ctrl+E flips the POPUP between Write and Preview",
    flipped.previewActive && flipped.renderedShown,
    `preview=${flipped.previewActive} rendered=${flipped.renderedShown}`);
  check("...and leaves the note behind it exactly as it was",
    flipped.viewMode === before.viewMode && flipped.editing === before.editing,
    `viewMode ${before.viewMode}→${flipped.viewMode}, raw editor ${before.editing}→${flipped.editing}`);

  await press("e");
  const back = await page.evaluate(`() => {
    const root = document.querySelector(".highlight-note-editor");
    return root.querySelectorAll(".highlight-note-editor-mode")[0].classList.contains("is-active");
  }`);
  check("...and again flips it back", back);

  // ── The Highlights tab's in-place editor ────────────────────────────────
  const inPlace = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.closeHighlightNoteEditor();
    await settle(200);
    api.setViewMode("highlights");
    await settle(700);
    const list = document.getElementById("highlightsList");
    const article = list.querySelector(".hl-note");
    article.querySelector(".hl-note-body").click();
    await settle(200);
    const area = article.querySelector(".hl-note-edit");
    if (!area) return { error: "pressing a note body opened no textarea" };
    area.focus();
    // Located, not assumed: the popup cases above have already reformatted this
    // note, so a fixed offset would select somebody else's asterisks.
    const at = area.value.indexOf("about it");
    area.setSelectionRange(at, at + "about it".length);
    return { value: area.value, selected: area.value.slice(at, at + "about it".length), viewMode: api.state.viewMode };
  }`);
  check("the Highlights tab opens a note in place", !inPlace.error, inPlace.error || "");

  if (!inPlace.error) {
    await press("b");
    const inPlaceBold = await page.evaluate(`() => {
      const { api } = window.__recall;
      const area = document.querySelector("#highlightsList .hl-note-edit");
      return { value: area ? area.value : null, viewMode: api.state.viewMode };
    }`);
    check("...and Ctrl+B works there too, on the same terms",
      inPlaceBold.value === inPlace.value.replace("about it", "**about it**"),
      JSON.stringify(inPlaceBold.value));
    check("...without the view changing under it",
      inPlaceBold.viewMode === "highlights", inPlaceBold.viewMode);

    await press("e");
    const committed = await page.evaluate(`() => {
      const { api } = window.__recall;
      const list = document.getElementById("highlightsList");
      return {
        stillEditing: Boolean(list.querySelector(".hl-note-edit")),
        stored: api.readHighlightNotes(api.state.notes || "").get("hn-aaaa") || "",
        viewMode: api.state.viewMode
      };
    }`);
    check("...and Ctrl+E puts the textarea away, saving what was typed",
      !committed.stillEditing && committed.stored === inPlace.value.replace("about it", "**about it**") && committed.viewMode === "highlights",
      `editing=${committed.stillEditing} stored=${JSON.stringify(committed.stored)} view=${committed.viewMode}`);
  }
} finally {
  await client.close?.();
  launched.proc?.kill();
  server.proc?.kill();
}

console.log(failures
  ? `\nnote-editor-check: ${failures} failure(s)`
  : "\nnote-editor-check: the note editors own their own keys");
process.exit(failures ? 1 : 0);
