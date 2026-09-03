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
// The same battery runs against the in-place editor in the side-by-side pane,
// because that is the other place a note is written and the two must not
// disagree about what a key does.
//
// ── ...and what a PRESS does ──────────────────────────────────────────────
//
// A note listed beside its highlight used to open into raw markdown on a single
// click, with the caret pinned to the end of the text — so it could not be
// selected out of, could not be formatted where it stood, and could not be
// opened at the sentence the reader was looking at. The cases below are the
// three halves of the answer: a click leaves it rendered and raises the pill
// over it, a triple-click crosses to the markdown at the word under the
// pointer, and Ctrl+E flips the two rather than closing the editor.
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
    "/src/notes/selection.js?v=__BUILD__",
    "/src/format/selection-tools.js?v=__BUILD__",
    "/src/panels/highlights-editor.js?v=__BUILD__",
    "/src/panels/highlights-panel.js?v=__BUILD__",
    "/src/panels/highlight-cycle.js?v=__BUILD__",
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
    root.querySelectorAll(".note-editor-mode")[0].click();
    await settle(200);
    area.focus();
    area.setSelectionRange(0, "What I wrote".length);
    return {
      open: !root.hidden,
      value: area.value,
      viewMode: api.state.viewMode,
      editing: api.isNotesEditing(),
      writeActive: root.querySelectorAll(".note-editor-mode")[0].classList.contains("is-active")
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
    const modes = root.querySelectorAll(".note-editor-mode");
    return {
      viewMode: api.state.viewMode,
      editing: api.isNotesEditing(),
      previewActive: modes[1].classList.contains("is-active"),
      renderedShown: !root.querySelector(".note-editor-rendered").hidden
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
    return root.querySelectorAll(".note-editor-mode")[0].classList.contains("is-active");
  }`);
  check("...and again flips it back", back);

  // ── The side-by-side pane's in-place editor ─────────────────────────────
  //
  // This used to be the Highlights TAB (api.setViewMode("highlights")). There is
  // no such view any more — the cards are the same cards, rendered by the same
  // renderHighlightsEditor into #highlightCycleBody beside the surface the
  // highlights are on — so the battery is asked of the pane instead. It is the
  // same question as before and one more: a note listed here must behave like a
  // note, which means a click SELECTS rather than dropping into raw markdown.
  const inPlace = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.closeHighlightNoteEditor();
    await settle(200);
    api.setViewMode("notes");
    await settle(400);
    api.openHighlightSplit("notes");
    await settle(700);
    const list = document.getElementById("highlightCycleBody");
    const article = list.querySelector(".hl-note");
    if (!article) return { error: "the pane listed no highlights" };

    // The regression this whole change is about: one click used to open the
    // editor, in raw markdown, caret at the end of the text.
    article.querySelector(".hl-note-body").click();
    await settle(200);
    const openedOnClick = Boolean(article.querySelector(".hl-note-editor .note-editor-input"));

    article.querySelector(".hl-note-edit").click();
    await settle(200);
    const area = article.querySelector(".hl-note-editor .note-editor-input");
    if (!area) return { error: "pressing ✎ opened no textarea", openedOnClick };
    area.focus();
    // Located, not assumed: the popup cases above have already reformatted this
    // note, so a fixed offset would select somebody else's asterisks.
    const at = area.value.indexOf("about it");
    area.setSelectionRange(at, at + "about it".length);
    return { value: area.value, openedOnClick, viewMode: api.state.viewMode };
  }`);
  check("a click on a rendered note leaves it rendered", !inPlace.openedOnClick,
    inPlace.openedOnClick ? "one click dropped straight into raw markdown" : "");
  check("...and ✎ opens that note in place", !inPlace.error, inPlace.error || "");

  if (!inPlace.error) {
    await press("b");
    const inPlaceBold = await page.evaluate(`() => {
      const { api } = window.__recall;
      const area = document.querySelector("#highlightCycleBody .hl-note-editor .note-editor-input");
      return { value: area ? area.value : null, viewMode: api.state.viewMode };
    }`);
    check("...and Ctrl+B works there too, on the same terms",
      inPlaceBold.value === inPlace.value.replace("about it", "**about it**"),
      JSON.stringify(inPlaceBold.value));
    check("...without the view changing under it",
      inPlaceBold.viewMode === "notes", inPlaceBold.viewMode);

    // Ctrl+E used to COMMIT here — the same keystroke as Esc, which left a
    // reader with no way to look at a note's rendered form without giving up
    // their place in it. It flips, like it does everywhere else.
    await press("e");
    const flippedInPlace = await page.evaluate(`() => {
      const root = document.querySelector("#highlightCycleBody .hl-note-editor");
      if (!root) return { gone: true };
      return {
        gone: false,
        previewActive: root.querySelectorAll(".note-editor-mode")[1].classList.contains("is-active"),
        renderedShown: !root.querySelector(".note-editor-rendered").hidden
      };
    }`);
    check("...and Ctrl+E flips it to Preview rather than closing it",
      !flippedInPlace.gone && flippedInPlace.previewActive && flippedInPlace.renderedShown,
      flippedInPlace.gone ? "the editor closed" : `preview=${flippedInPlace.previewActive} rendered=${flippedInPlace.renderedShown}`);

    await press("e");
    const backInPlace = await page.evaluate(`() => {
      const root = document.querySelector("#highlightCycleBody .hl-note-editor");
      return Boolean(root && root.querySelectorAll(".note-editor-mode")[0].classList.contains("is-active"));
    }`);
    check("...and again flips it back to Write", backInPlace);

    const committed = await page.evaluate(`async () => {
      const { api, settle } = window.__recall;
      const area = document.querySelector("#highlightCycleBody .hl-note-editor .note-editor-input");
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(300);
      return {
        stillEditing: Boolean(document.querySelector("#highlightCycleBody .hl-note-editor .note-editor-input")),
        stored: api.readHighlightNotes(api.state.notes || "").get("hn-aaaa") || "",
        viewMode: api.state.viewMode
      };
    }`);
    check("...and Esc puts the textarea away, saving what was typed",
      !committed.stillEditing && committed.stored === inPlace.value.replace("about it", "**about it**") && committed.viewMode === "notes",
      `editing=${committed.stillEditing} stored=${JSON.stringify(committed.stored)} view=${committed.viewMode}`);
  }

  // ── Triple-click lands the caret where you aimed it ─────────────────────
  //
  // The one that made the panel feel broken: whatever you pressed on, the caret
  // went to the END of the note. On a three-line note that is a nuisance; on a
  // note of several paragraphs it means the gesture tells you nothing about
  // where you will be typing. A long note with distinct paragraphs is used here
  // precisely so "landed near the click" and "landed at the end" cannot be
  // confused for one another.
  const TRIPLE_NOTE = "First paragraph, at the very top.\n\nSecond paragraph, in the middle.\n\nThird paragraph, at the end.";
  const aimed = await page.evaluate(`async () => {
    const { api, settle } = window.__recall;
    api.setHighlightNoteAt(1, ${JSON.stringify(TRIPLE_NOTE)}, { rerender: false });
    api.refreshHighlightCycle();
    await settle(600);
    const list = document.getElementById("highlightCycleBody");
    const article = [...list.querySelectorAll(".hl-note")]
      .find((a) => a.dataset.highlightKey === "mark:1");
    if (!article) return { error: "the pane did not list the second highlight" };
    const body = article.querySelector(".hl-note-body");
    const paragraphs = body.querySelectorAll("p");
    if (paragraphs.length < 3) return { error: "the note rendered as " + paragraphs.length + " paragraph(s)" };
    const box = paragraphs[0].getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    (document.elementFromPoint(x, y) || body).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, detail: 3, clientX: x, clientY: y })
    );
    await settle(300);
    const area = article.querySelector(".hl-note-editor .note-editor-input");
    if (!area) return { error: "a triple-click opened no textarea" };
    return { caret: area.selectionStart, length: area.value.length, firstLine: area.value.indexOf("\\n") };
  }`);
  check("a triple-click opens the raw markdown where you pressed, not at the end",
    !aimed.error && aimed.caret <= aimed.firstLine && aimed.caret < aimed.length,
    aimed.error || `caret ${aimed.caret} of ${aimed.length}, first line ends at ${aimed.firstLine}`);

// ── The floating pill, over the note editors ────────────────────────────────
//
// "Both in the popup and in the dedicated highlights panel the texts are not
// having all the features that we've implemented for raw and rendered nodes in
// notes selection."
//
// The pill is that feature set — bold, colour, highlight, erase, copy, share,
// web search — and neither editor raised it: selecting a phrase in a note about
// a highlight did nothing at all. Both surfaces register as selection targets
// now (src/notes/note-editor-kit.js), so the assertions below are the same
// question asked of each: does the bar appear, does it offer the right
// buttons, and does pressing one actually change the note.
const pillPopup = await page.evaluate(`async () => {
  const { api, settle } = window.__recall;
  api.setViewMode("notes");
  await settle(300);
  api.openHighlightNoteEditor(0, { top: 100, left: 100, bottom: 120, right: 200 }, "A sentence to format.");
  await settle(400);
  // A note that already has text opens in Preview — see openHighlightNoteEditor.
  // The textarea case has to ask for Write, or it would be selecting inside a
  // hidden element and proving nothing.
  document.querySelectorAll(".note-editor-mode")[0].click();
  await settle(250);
  const area = document.querySelector(".note-editor-kit .note-editor-input");
  area.focus();
  const at = area.value.indexOf("to format");
  area.setSelectionRange(at, at + "to format".length);
  api.positionNotesSelectionButton();
  await settle(120);
  const pill = document.getElementById("selectionFloat");
  const shown = {
    visible: !pill.hidden,
    target: pill.dataset.renderTarget || "",
    format: !document.getElementById("selectionFloatFormat").hidden,
    highlight: !document.getElementById("highlightSelectionBtn").hidden,
    // Neither of these has a home in a note ABOUT a highlight: a cloze here
    // would be listed by the Cloze panel as one of the note's own, and
    // "extract into its own note" is a notes-only verb.
    cloze: !document.getElementById("makeClozeFromSelectionBtn").hidden,
    extract: !document.getElementById("extractNoteFromSelectionBtn").hidden
  };
  // ...and it acts on the note, not on the note behind it.
  const notesBefore = api.state.notes || "";
  api.applyPillHighlight("green");
  await settle(200);
  const after = document.querySelector(".note-editor-kit .note-editor-input");
  return {
    shown,
    value: after ? after.value : "",
    notesUntouched: (api.state.notes || "") === notesBefore
  };
}`);

check("the pill appears over the note popup's textarea",
  pillPopup.shown.visible && pillPopup.shown.target === "highlight-note",
  `visible=${pillPopup.shown.visible} target=${pillPopup.shown.target}`);
check("...offering formatting and highlight, but not cloze or split-out",
  pillPopup.shown.format && pillPopup.shown.highlight
    && !pillPopup.shown.cloze && !pillPopup.shown.extract,
  `format=${pillPopup.shown.format} highlight=${pillPopup.shown.highlight} cloze=${pillPopup.shown.cloze} extract=${pillPopup.shown.extract}`);
check("...and its Highlight marks up the NOTE, not the note behind it",
  /<mark[^>]*>to format<\/mark>/.test(pillPopup.value) && pillPopup.notesUntouched,
  JSON.stringify(pillPopup.value));

const pillPreview = await page.evaluate(`async () => {
  const { api, settle } = window.__recall;
  // Preview mode: the same pill, resolved through the RENDERED half of the same
  // surface, which is the path applyRenderFormat takes to match a selection back
  // into the markdown.
  document.querySelectorAll(".note-editor-mode")[1].click();
  await settle(400);
  const rendered = document.querySelector(".note-editor-kit .note-editor-rendered");
  const walker = document.createTreeWalker(rendered, NodeFilter.SHOW_TEXT);
  let node = null;
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue.includes("sentence")) { node = walker.currentNode; break; }
  }
  if (!node) return { error: "no rendered text to select" };
  const at = node.nodeValue.indexOf("sentence");
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + "sentence".length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  api.positionNotesSelectionButton();
  await settle(150);
  const pill = document.getElementById("selectionFloat");
  const visible = !pill.hidden && pill.dataset.renderTarget === "highlight-note";
  api.applyPillHighlight("blue");
  await settle(300);
  api.closeHighlightNoteEditor();
  await settle(300);
  return { visible, stored: api.readHighlightNotes(api.state.notes || "").get("hn-aaaa") || "" };
}`);

check("the pill appears over the popup's PREVIEW too", !pillPreview.error && pillPreview.visible,
  pillPreview.error || String(pillPreview.visible));
check("...and formatting there is spliced into the note's markdown",
  /<mark[^>]*>sentence<\/mark>/.test(pillPreview.stored || ""),
  JSON.stringify((pillPreview.stored || "").slice(0, 80)));

const pillPanel = await page.evaluate(`async () => {
  const { api, settle } = window.__recall;
  api.setViewMode("notes");
  await settle(400);
  api.openHighlightSplit("notes");
  await settle(700);
  const list = document.getElementById("highlightCycleBody");
  const article = list.querySelector(".hl-note");
  article.querySelector(".hl-note-edit").click();
  await settle(300);
  const kit = article.querySelector(".hl-note-editor");
  if (!kit) return { error: "pressing ✎ opened no editor" };
  const toolbar = kit.querySelector(".edit-toolbar");
  const area = kit.querySelector(".note-editor-input");
  area.focus();
  const at = area.value.indexOf("sentence");
  area.setSelectionRange(at, at + "sentence".length);
  api.positionNotesSelectionButton();
  await settle(150);
  const pill = document.getElementById("selectionFloat");
  const result = {
    // The in-place editor is the whole kit now, not a lone textarea.
    toolbar: Boolean(toolbar && toolbar.querySelectorAll("button").length > 5),
    modes: kit.querySelectorAll(".note-editor-mode").length,
    mirror: Boolean(kit.querySelector(".highlight-textarea-backdrop")),
    visible: !pill.hidden && pill.dataset.renderTarget === "highlight-note"
  };
  api.applyPillHighlight("pink");
  await settle(250);
  result.value = kit.querySelector(".note-editor-input")?.value || "";
  api.commitOpenNote();
  await settle(300);
  result.stored = api.readHighlightNotes(api.state.notes || "").get("hn-aaaa") || "";
  return result;
}`);

check("the pane's editor carries the popup's whole kit",
  !pillPanel.error && pillPanel.toolbar && pillPanel.modes === 2 && pillPanel.mirror,
  pillPanel.error || `toolbar=${pillPanel.toolbar} modes=${pillPanel.modes} mirror=${pillPanel.mirror}`);
check("...and the pill appears over it as well",
  Boolean(pillPanel.visible), String(pillPanel.visible));
check("...writing through to the same note the popup writes to",
  /<mark[^>]*>sentence<\/mark>/.test(pillPanel.stored || ""),
  JSON.stringify((pillPanel.stored || "").slice(0, 80)));

// ── ...and over a card with NO editor open at all ──────────────────────────
//
// The half that made "a click selects" a real answer rather than a smaller
// feature set. Until now the pill only appeared over a registered target, and
// the only registration was the one an open editor makes — so selecting a
// phrase in a rendered note did nothing, and the only way to bold a word was to
// open the editor first, which is the behaviour this change removes. A rendered
// card registers itself (registerCardTarget), under the same name the kit uses,
// so cloze and split-out stay withheld here exactly as they are in the popup.
const pillRendered = await page.evaluate(`async () => {
  const { api, settle } = window.__recall;
  api.setHighlightNoteAt(0, "A rendered sentence to format.", { rerender: false });
  api.refreshHighlightCycle();
  await settle(600);
  const list = document.getElementById("highlightCycleBody");
  const article = [...list.querySelectorAll(".hl-note")].find((a) => a.dataset.highlightKey === "mark:0");
  if (!article) return { error: "the pane did not list the annotated highlight" };
  const body = article.querySelector(".hl-note-body");
  if (article.querySelector(".hl-note-editor")) return { error: "an editor was already open" };
  // The press that registers the card, then a real selection inside it.
  // pointerup as well as pointerdown: the touch-selection controller treats a
  // pointerdown with no matching up as a drag still in progress, and the pill
  // deliberately draws nothing while one is (selectionGestureIsLive).
  body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  const text = [...body.querySelectorAll("p")][0]?.firstChild;
  if (!text) return { error: "the note rendered no text to select" };
  const at = text.textContent.indexOf("sentence");
  const range = document.createRange();
  range.setStart(text, at);
  range.setEnd(text, at + "sentence".length);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  api.positionNotesSelectionButton();
  await settle(150);
  const pill = document.getElementById("selectionFloat");
  const result = {
    visible: !pill.hidden && pill.dataset.renderTarget === "highlight-note",
    // Cloze is withheld on a note, whichever half of it is on screen.
    cloze: !document.getElementById("makeClozeFromSelectionBtn")?.hidden,
    editorOpen: Boolean(article.querySelector(".hl-note-editor"))
  };
  api.applyPillHighlight("green");
  await settle(400);
  result.stored = api.readHighlightNotes(api.state.notes || "").get("hn-aaaa") || "";
  return result;
}`);

check("the pill appears over a rendered card with no editor open",
  !pillRendered.error && pillRendered.visible && !pillRendered.editorOpen,
  pillRendered.error || `visible=${pillRendered.visible} editorOpen=${pillRendered.editorOpen}`);
check("...and formatting there is written into that highlight's note",
  /<mark[^>]*>sentence<\/mark>/.test(pillRendered.stored || ""),
  JSON.stringify((pillRendered.stored || "").slice(0, 80)));
check("...with cloze still withheld, because a note is not a card face",
  !pillRendered.cloze, String(pillRendered.cloze));

  // ── The drawing sheet ────────────────────────────────────────────────────
  //
  // Handwriting in a note is a picture: you draw in a sheet, and what you drew
  // lands in the markdown where the caret was as an ordinary `![](…)`. Driven
  // here rather than in tools/pdf-preview-check.mjs (which owns the pen ON a
  // paper) because this is a NOTE editor, and because the two are separate
  // engines that could drift.
  //
  // The stroke is a real stylus through Chrome's own input pipeline, for the
  // same reason every other press in this file is real: the sheet reads
  // pointerType off a trusted event.
  const sheet = await page.evaluate(`async () => {
    // The app is not signed in in this harness, so its own overlay covers the
    // screen. A reader drawing in a note has a session.
    document.querySelectorAll(".login-overlay").forEach((n) => n.remove());
    const mod = await import("/src/notes/ink-sheet.js?v=__BUILD__");
    const ta = document.querySelector("#notesEdit");
    if (!ta) return { error: "no notes textarea" };
    ta.hidden = false;
    ta.value = "before-after";
    ta.selectionStart = ta.selectionEnd = 6;
    mod.insertInkDrawing(ta, 6);
    await new Promise((r) => setTimeout(r, 200));
    const el = document.querySelector(".ink-sheet");
    const host = document.querySelector(".ink-sheet-host");
    if (!el || el.hidden || !host) return { error: "the sheet did not open" };
    const box = host.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + (box.width / 2), box.top + (box.height / 2));
    return {
      open: mod.isInkSheetOpen(),
      pens: el.querySelectorAll("[data-ink-pen]").length,
      nibs: el.querySelectorAll("[data-ink-width]").length,
      tools: el.querySelectorAll("[data-ink-tool]").length,
      // The sheet must be ON TOP. The app's toolbar is z-index 500 and its
      // panels run to 400; a sheet below them is a drawing surface with a row
      // of the app's buttons floating in the middle of it, and — as this check
      // found the first time it ran — one that never receives a stroke at all.
      onTop: Boolean(at && at.closest(".ink-sheet")),
      x: Math.round(box.left + (box.width / 2)),
      y: Math.round(box.top + (box.height / 2))
    };
  }`);

  if (sheet.error) {
    check("the ✎ opens a drawing sheet", false, sheet.error);
  } else {
    check("the ✎ opens a drawing sheet", sheet.open, `open=${sheet.open}`);
    check("...with the pens, the nibs and the three tools on it",
      sheet.pens === 5 && sheet.nibs === 4 && sheet.tools === 3,
      `${sheet.pens} pen(s), ${sheet.nibs} nib(s), ${sheet.tools} tool(s)`);
    check("...above everything else on the screen", sheet.onTop, `topmost=${sheet.onTop}`);

    const stroke = [];
    for (let i = 0; i <= 20; i += 1) {
      stroke.push([sheet.x - 100 + (i * 10), sheet.y + Math.round(Math.sin(i / 3) * 30), 0.5 + (0.3 * Math.sin(i / 5))]);
    }
    await page.penStroke(stroke);

    const drawn = await page.evaluate(`() => {
      const canvas = document.querySelector(".ink-sheet-host canvas");
      if (!canvas) return { painted: 0 };
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) painted += 1;
      return { painted };
    }`);
    check("...and a stylus draws on it", drawn.painted > 100, `${drawn.painted} inked pixel(s)`);

    const done = await page.evaluate(`async () => {
      const ta = document.querySelector("#notesEdit");
      const before = ta.value;
      document.querySelector(".ink-sheet-done").click();
      // Read SYNCHRONOUSLY. insertPreparedImageUpload puts its placeholder in
      // before its first await, and with no session behind this harness the
      // upload then fails and withdraws it within a few milliseconds — so
      // anything later sees the note exactly as it started and proves nothing.
      const straightAway = ta.value;
      await new Promise((r) => setTimeout(r, 400));
      return {
        inserted: straightAway !== before,
        placedAtCaret: straightAway.startsWith("before") && straightAway.endsWith("-after"),
        isAnImage: straightAway.includes("![") && straightAway.includes("]("),
        closed: document.querySelector(".ink-sheet").hidden,
        withdrawn: ta.value === before
      };
    }`);
    check("Done puts the drawing into the note", done.inserted && done.isAnImage, `inserted=${done.inserted}, image=${done.isAnImage}`);
    check("...exactly where the caret was", done.placedAtCaret, `placed=${done.placedAtCaret}`);
    check("...and closes the sheet", done.closed, `closed=${done.closed}`);
    check("...while an upload that cannot happen takes its placeholder back out",
      done.withdrawn, `withdrawn=${done.withdrawn}`);
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
